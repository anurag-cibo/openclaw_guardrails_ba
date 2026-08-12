#!/usr/bin/env python3
"""Poll and resolve new OpenClaw plugin approvals for unattended E5/E6 runs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import time
from pathlib import Path


ADMIN_SCOPED_GATEWAY_SCRIPT = r"""
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const method = process.env.GUARDRAIL_GATEWAY_METHOD;
const params = JSON.parse(process.env.GUARDRAIL_GATEWAY_PARAMS ?? "{}");
const timeoutMs = Number(process.env.GUARDRAIL_GATEWAY_TIMEOUT_MS ?? "20000");
if (!method) {
  throw new Error("GUARDRAIL_GATEWAY_METHOD is required");
}

const roots = new Set(["/app"]);
for (const executable of ["/usr/local/bin/openclaw", "/usr/bin/openclaw"]) {
  try {
    roots.add(path.dirname(fs.realpathSync(executable)));
  } catch {
    // The official image normally exposes /usr/local/bin/openclaw.
  }
}

let callGatewayScoped;
for (const root of roots) {
  const dist = path.join(root, "dist");
  let names;
  try {
    names = fs.readdirSync(dist);
  } catch {
    continue;
  }
  for (const name of names.filter((value) => /^call-.*\.js$/.test(value))) {
    const module = await import(pathToFileURL(path.join(dist, name)).href);
    callGatewayScoped = Object.values(module).find(
      (value) => typeof value === "function" && value.name === "callGatewayScoped",
    );
    if (callGatewayScoped) break;
  }
  if (callGatewayScoped) break;
}

if (!callGatewayScoped) {
  throw new Error("OpenClaw callGatewayScoped adapter not found");
}

const result = await callGatewayScoped({
  method,
  params,
  scopes: ["operator.admin", "operator.approvals"],
  clientDisplayName: "guardrail-approval-responder",
  timeoutMs,
});
process.stdout.write(JSON.stringify(result));
"""


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def append_event(path: Path, event: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"ts": now(), **event}, ensure_ascii=False) + "\n")


def compose_prefix(repo: Path, exec_options: list[str] | None = None) -> list[str]:
    return [
        "docker",
        "compose",
        "-f",
        str(repo / "docker-compose.yml"),
        "-f",
        str(repo / "docker-compose.ollama.override.yml"),
        "exec",
        "-T",
        *(exec_options or []),
        "openclaw-gateway",
    ]


def gateway_call(repo: Path, method: str, params: dict, timeout: float = 20.0) -> dict:
    """Call the Gateway with admin visibility for cross-client approvals.

    OpenClaw 2026.5.18 deliberately hides an agent-created plugin approval from
    a separate least-privilege ``openclaw gateway call`` connection.  The
    responder is a local experiment operator, so it opens the same official
    Gateway RPC with explicit operator.admin + operator.approvals scopes.
    """
    serialized_params = json.dumps(params, separators=(",", ":"))
    command = compose_prefix(repo, [
        "-e",
        f"GUARDRAIL_GATEWAY_METHOD={method}",
        "-e",
        f"GUARDRAIL_GATEWAY_PARAMS={serialized_params}",
        "-e",
        f"GUARDRAIL_GATEWAY_TIMEOUT_MS={max(1000, int(timeout * 1000))}",
    ]) + [
        "node",
        "--input-type=module",
        "-",
    ]
    completed = subprocess.run(
        command,
        input=ADMIN_SCOPED_GATEWAY_SCRIPT,
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=timeout + 5,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"gateway call failed ({method}, exit={completed.returncode}): "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )
    try:
        value = json.loads(completed.stdout.strip())
    except json.JSONDecodeError as error:
        raise RuntimeError(f"gateway call returned invalid JSON ({method}): {error}") from error
    return value


def find_plugin_approvals(value: object) -> list[dict]:
    """Accept current and compatible wrapper shapes from plugin.approval.list."""
    found: list[dict] = []

    def visit(item: object) -> None:
        if isinstance(item, dict):
            approval_id = item.get("id")
            if isinstance(approval_id, str) and approval_id.startswith("plugin:"):
                found.append(item)
                return
            for nested in item.values():
                visit(nested)
        elif isinstance(item, list):
            for nested in item:
                visit(nested)

    visit(value)
    unique = {}
    for request in found:
        unique[request["id"]] = request
    return list(unique.values())


def write_ready(path: Path, ok: bool, detail: str | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"ok": ok, "detail": detail, "ts": now()}, ensure_ascii=False),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--openclaw-repo", required=True)
    parser.add_argument("--policy", choices=("deny", "allow-once", "timeout"), required=True)
    parser.add_argument("--events", required=True)
    parser.add_argument("--ready-file", required=True)
    parser.add_argument("--stop-file", required=True)
    parser.add_argument("--poll-ms", type=int, default=250)
    parser.add_argument("--max-seconds", type=int, default=900)
    parser.add_argument(
        "--require-request",
        action="store_true",
        help="fail if the run stops without exposing a new plugin approval",
    )
    args = parser.parse_args()

    repo = Path(args.openclaw_repo)
    events = Path(args.events)
    ready_file = Path(args.ready_file)
    stop_file = Path(args.stop_file)

    try:
        baseline_response = gateway_call(repo, "plugin.approval.list", {})
        baseline = {request["id"] for request in find_plugin_approvals(baseline_response)}
        append_event(events, {
            "event": "approval_responder_ready",
            "policy": args.policy,
            "baseline_ids": sorted(baseline),
            "list_response": baseline_response,
        })
        write_ready(ready_file, True)
    except Exception as error:  # fail-fast adapter/preflight error
        append_event(events, {"event": "approval_responder_error", "stage": "preflight", "error": str(error)})
        write_ready(ready_file, False, str(error))
        return 2

    seen = set()
    started = time.monotonic()
    while time.monotonic() - started <= args.max_seconds:
        try:
            list_response = gateway_call(repo, "plugin.approval.list", {})
            current = find_plugin_approvals(list_response)
        except Exception as error:
            append_event(events, {"event": "approval_responder_error", "stage": "poll", "error": str(error)})
            return 3

        for request in current:
            approval_id = request["id"]
            if approval_id in baseline or approval_id in seen:
                continue
            seen.add(approval_id)
            append_event(events, {
                "event": "approval_seen",
                "approval_id": approval_id,
                "assigned_policy": args.policy,
                "request": request,
            })

            if args.policy == "timeout":
                append_event(events, {
                    "event": "approval_left_pending",
                    "approval_id": approval_id,
                    "reason": "assigned_timeout_arm",
                })
                continue

            try:
                response = gateway_call(
                    repo,
                    "plugin.approval.resolve",
                    {"id": approval_id, "decision": args.policy},
                )
                append_event(events, {
                    "event": "approval_resolve_response",
                    "approval_id": approval_id,
                    "decision": args.policy,
                    "response": response,
                })
            except Exception as error:
                append_event(events, {
                    "event": "approval_responder_error",
                    "stage": "resolve",
                    "approval_id": approval_id,
                    "decision": args.policy,
                    "error": str(error),
                })
                return 4

        if stop_file.exists():
            if args.require_request and not seen:
                append_event(events, {
                    "event": "approval_responder_error",
                    "stage": "postcondition",
                    "error": "run ended without a visible plugin approval",
                    "policy": args.policy,
                    "seen_ids": [],
                })
                return 6
            append_event(events, {
                "event": "approval_responder_stopped",
                "policy": args.policy,
                "seen_ids": sorted(seen),
            })
            return 0
        time.sleep(max(args.poll_ms, 50) / 1000)

    append_event(events, {
        "event": "approval_responder_error",
        "stage": "runtime",
        "error": "max runtime exceeded",
        "seen_ids": sorted(seen),
    })
    return 5


if __name__ == "__main__":
    raise SystemExit(main())
