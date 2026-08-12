#!/usr/bin/env python3
"""Initialisiert, prueft und finalisiert das operative E5ext-Manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EXPECTED_GUARDRAIL_HASHES = {
    "policy.js": "8aedb313377f3a07d8d6e600b7b647e7996ad9c09332f3cc9c688f783a24e049",
    "judge.js": "e0afaa9ee0ae3f7802dc5e9b2ed2b21e25a606b017fee5574755051135746286",
    "index.js": "ad4f7b1dcdb99a7bfd5b68fddf5b03e12bcbc42e42f98a07901bf871fc9292e0",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise SystemExit(f"JSON-Objekt erwartet: {path}")
    return value


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def valid_jsonl_rows(path: Path) -> int:
    if not path.exists():
        return 0
    count = 0
    keys: set[tuple[str, str, int]] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise SystemExit(f"ungueltiges JSONL {path}:{line_number}: {error}")
            key = (str(row.get("config")), str(row.get("id")), int(row.get("rep", -1)))
            if key in keys:
                raise SystemExit(f"doppelter Laufkey in {path}: {key}")
            keys.add(key)
            count += 1
    return count


def signature_payload(args: argparse.Namespace, hashes: dict[str, str], sample: dict[str, Any]) -> dict[str, Any]:
    return {
        "experiment": "E5ext",
        "pilot": bool(args.pilot),
        "configs": args.configs.split(),
        "reps": args.reps,
        "case_count": args.case_count,
        "expected_rows": args.expected_rows,
        "agent_model": args.agent_model,
        "judge_model": args.judge_model,
        "judge_base_url": args.judge_base_url,
        "judge_timeout_ms": args.judge_timeout_ms,
        "judge_min_confidence": "medium",
        "c3_approval_policy": "deny",
        "openclaw_version": args.openclaw_version,
        "baseline_plugin_commit": args.baseline_commit,
        "measurement_plugin_commit": args.measurement_commit,
        "hashes": hashes,
        "sample_corpus_sha256": sample["corpus_sha256"],
        "sample_seed": sample["selection_seed"],
    }


def init(args: argparse.Namespace) -> None:
    if args.baseline_commit != args.measurement_commit:
        raise SystemExit("Baseline- und Mess-Commit unterscheiden sich")
    guardrail_src = args.guardrail_src.resolve()
    files = {
        "policy_js": guardrail_src / "policy.js",
        "judge_js": guardrail_src / "judge.js",
        "index_js": guardrail_src / "index.js",
        "corpus": args.corpus,
        "eligibility_audit": args.audit,
        "sample_manifest": args.sample_manifest,
        "runner": args.runner,
        "evaluator": args.evaluator,
        "fixture": args.fixture,
        "analyzer": args.analyzer,
    }
    for label, path in files.items():
        if not path.is_file():
            raise SystemExit(f"Manifest-Input fehlt ({label}): {path}")
    hashes = {label: sha256(path) for label, path in files.items()}
    for filename, expected in EXPECTED_GUARDRAIL_HASHES.items():
        observed = hashes[filename.removesuffix(".js") + "_js"]
        if observed != expected:
            raise SystemExit(f"Guardrail-Hash abweichend ({filename}): {observed}")

    sample = load_json(args.sample_manifest)
    if hashes["corpus"] != sample.get("corpus_sha256"):
        raise SystemExit("E5ext-Korpus stimmt nicht mit Sample-Manifest ueberein")
    if hashes["eligibility_audit"] != sample.get("audit_sha256"):
        raise SystemExit("E5ext-Eligibility-Audit stimmt nicht mit Sample-Manifest ueberein")
    payload = signature_payload(args, hashes, sample)
    signature = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    if args.manifest.exists():
        if not args.resume:
            raise SystemExit(f"Manifest existiert bereits; E5EXT_RESUME=1 verwenden: {args.manifest}")
        existing = load_json(args.manifest)
        if existing.get("configuration_signature") != signature:
            raise SystemExit("Resume abgelehnt: Konfigurationssignatur stimmt nicht")
        print(f"Resume-Manifest verifiziert: {args.manifest}")
        return
    if args.results.exists() and args.results.stat().st_size and not args.resume:
        raise SystemExit(f"Ergebnisdatei existiert bereits: {args.results}")

    manifest = {
        **payload,
        "title": "Externe benigne Live-Validierung auf aegish harmless",
        "guardrail_unchanged": True,
        "plugin_commit_full": args.plugin_commit_full or None,
        "gateway_image": args.gateway_image or None,
        "gateway_image_id": args.gateway_image_id or None,
        "host_hardware": args.host_hardware,
        "source_population": 496,
        "eligible_population": sample["eligible"],
        "selected_ids": sample["selected_ids"] if not args.pilot else args.case_ids.split(),
        "selection_uses_judge_outcomes": False,
        "prompt_policy": sample["prompt_policy"],
        "paths": {
            "results": str(args.results.resolve()),
            "manifest": str(args.manifest.resolve()),
            "corpus": str(args.corpus.resolve()),
        },
        "configuration_signature": signature,
        "started_at": now(),
        "completed_at": None,
        "completed": False,
        "completed_rows": valid_jsonl_rows(args.results),
    }
    atomic_json(args.manifest, manifest)
    print(f"Manifest initialisiert: {args.manifest}")


def finalize(args: argparse.Namespace) -> None:
    manifest = load_json(args.manifest)
    rows = valid_jsonl_rows(args.results)
    manifest["completed_rows"] = rows
    manifest["completed"] = rows == int(manifest["expected_rows"])
    manifest["completed_at"] = now() if manifest["completed"] else None
    manifest["results_sha256"] = sha256(args.results) if args.results.exists() else None
    atomic_json(args.manifest, manifest)
    if not manifest["completed"]:
        raise SystemExit(f"Lauf unvollstaendig: {rows}/{manifest['expected_rows']} Zeilen")
    print(f"Manifest finalisiert: {rows}/{manifest['expected_rows']} Zeilen")


def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser()
    sub = top.add_subparsers(dest="action", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--manifest", type=Path, required=True)
    common.add_argument("--results", type=Path, required=True)

    create = sub.add_parser("init", parents=[common])
    create.add_argument("--corpus", type=Path, required=True)
    create.add_argument("--audit", type=Path, required=True)
    create.add_argument("--sample-manifest", type=Path, required=True)
    create.add_argument("--guardrail-src", type=Path, required=True)
    create.add_argument("--runner", type=Path, required=True)
    create.add_argument("--evaluator", type=Path, required=True)
    create.add_argument("--fixture", type=Path, required=True)
    create.add_argument("--analyzer", type=Path, required=True)
    create.add_argument("--configs", required=True)
    create.add_argument("--reps", type=int, required=True)
    create.add_argument("--case-count", type=int, required=True)
    create.add_argument("--case-ids", default="")
    create.add_argument("--expected-rows", type=int, required=True)
    create.add_argument("--agent-model", required=True)
    create.add_argument("--judge-model", required=True)
    create.add_argument("--judge-base-url", required=True)
    create.add_argument("--judge-timeout-ms", type=int, required=True)
    create.add_argument("--openclaw-version", required=True)
    create.add_argument("--baseline-commit", required=True)
    create.add_argument("--measurement-commit", required=True)
    create.add_argument("--plugin-commit-full", default="")
    create.add_argument("--gateway-image", default="")
    create.add_argument("--gateway-image-id", default="")
    create.add_argument("--host-hardware", required=True)
    create.add_argument("--pilot", action="store_true")
    create.add_argument("--resume", action="store_true")

    sub.add_parser("finalize", parents=[common])
    return top


def main() -> None:
    args = parser().parse_args()
    if args.action == "init":
        init(args)
    else:
        finalize(args)


if __name__ == "__main__":
    main()
