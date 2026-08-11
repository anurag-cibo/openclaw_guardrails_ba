#!/usr/bin/env python3
"""Validiert und aggregiert die E3-HAW-Zielsystem-Replikation."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from pathlib import Path
from typing import Any


METRICS = ("mean_ms", "p50_ms", "p95_ms", "p99_ms", "min_ms", "max_ms")


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"JSON-Objekt erwartet: {path}")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def aggregate_layers(rounds: list[dict[str, Any]], layer: str) -> dict[str, Any]:
    rows = [item[layer] for item in rounds]
    output: dict[str, Any] = {
        "rounds": len(rows),
        "evaluations_per_round": rows[0]["n"],
        "evaluations_total": sum(row["n"] for row in rows),
    }
    for metric in METRICS:
        values = [float(row[metric]) for row in rows]
        output[metric] = {
            "round_values": values,
            "mean_across_rounds": statistics.fmean(values),
            "median_across_rounds": statistics.median(values),
            "min_across_rounds": min(values),
            "max_across_rounds": max(values),
        }
        if len(values) > 1:
            output[metric]["stdev_across_rounds"] = statistics.stdev(values)
        else:
            output[metric]["stdev_across_rounds"] = 0.0
    # Gleiche Rundengroesse: Mittel der Rundenmittel ist zugleich das gepoolte Mittel.
    output["pooled_mean_ms"] = output["mean_ms"]["mean_across_rounds"]
    output["global_min_ms"] = min(row["min_ms"] for row in rows)
    output["global_max_ms"] = max(row["max_ms"] for row in rows)
    return output


def compare_baseline(
    baseline: dict[str, Any], aggregate: dict[str, Any]
) -> dict[str, Any]:
    comparison: dict[str, Any] = {
        "baseline_meta": baseline.get("meta", {}),
        "note": (
            "Ratios verwenden fuer Mittelwerte den gepoolten HAW-Mittelwert und fuer "
            "Perzentile den Median der fuenf rundenweisen Perzentile. Perzentile werden "
            "nicht aus zusammengefassten Rohmessungen rekonstruiert."
        ),
    }
    for layer in ("overall_self", "overall_wall"):
        base = baseline[layer]
        current = aggregate[layer]
        layer_comparison: dict[str, Any] = {}
        for metric in ("mean_ms", "p50_ms", "p95_ms", "p99_ms"):
            haw_value = (
                current["pooled_mean_ms"]
                if metric == "mean_ms"
                else current[metric]["median_across_rounds"]
            )
            baseline_value = float(base[metric])
            ratio = haw_value / baseline_value if baseline_value else math.nan
            layer_comparison[metric] = {
                "windows": baseline_value,
                "haw": haw_value,
                "haw_over_windows": ratio,
                "percent_change": (ratio - 1.0) * 100.0,
            }
        comparison[layer] = layer_comparison
    return comparison


def fmt(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".")


def build_report(summary: dict[str, Any]) -> str:
    manifest = summary["manifest"]
    lines = [
        "# E3 – Policy-Latenz auf dem HAW-Zielsystem",
        "",
        f"Status: **{manifest['completed_rounds']}/{manifest['schedule']['rounds']} Runden vollständig**  ",
        f"Auswertungen: **{manifest['observed_total_evaluations']:,}**  ",
        f"Runtime: `{manifest['runtime']['node']}` auf `{manifest['runtime']['platform']}/{manifest['runtime']['arch']}`  ",
        f"Guardrail unverändert: **{str(manifest['guardrail_unchanged']).lower()}**, Commit `{manifest['measurement_plugin_commit']}`",
        "",
        "## HAW-Messung",
        "",
        "Die Werte sind Rundenaggregate. `p50/p95/p99` sind jeweils der Median der fünf rundenweisen Perzentile.",
        "",
        "| Messsicht | mean ms | p50 ms | p95 ms | p99 ms | Rundenbereich mean ms |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for label, key in (("Policy-intern", "overall_self"), ("Wall Clock", "overall_wall")):
        row = summary["aggregate"][key]
        lines.append(
            f"| {label} | {fmt(row['pooled_mean_ms'])} | "
            f"{fmt(row['p50_ms']['median_across_rounds'])} | "
            f"{fmt(row['p95_ms']['median_across_rounds'])} | "
            f"{fmt(row['p99_ms']['median_across_rounds'])} | "
            f"{fmt(row['mean_ms']['min_across_rounds'])}–{fmt(row['mean_ms']['max_across_rounds'])} |"
        )

    if summary.get("comparison_to_windows"):
        lines.extend([
            "",
            "## Vergleich zur bisherigen Windows-Messung",
            "",
            "| Messsicht | Metrik | Windows ms | HAW ms | HAW/Windows | Änderung |",
            "|---|---|---:|---:|---:|---:|",
        ])
        for label, key in (("Policy-intern", "overall_self"), ("Wall Clock", "overall_wall")):
            for metric in ("mean_ms", "p50_ms", "p95_ms", "p99_ms"):
                row = summary["comparison_to_windows"][key][metric]
                lines.append(
                    f"| {label} | {metric.removesuffix('_ms')} | {fmt(row['windows'])} | "
                    f"{fmt(row['haw'])} | {row['haw_over_windows']:.3f} | "
                    f"{row['percent_change']:+.1f} % |"
                )

    lines.extend([
        "",
        "## Interpretationsgrenze",
        "",
        "Der Vergleich repliziert dieselbe Policy und denselben Korpus auf dem Zielstack. "
        "Betriebssystem, Node-Version und CPU-Umgebung ändern sich gemeinsam; die Differenz "
        "darf daher nicht kausal einer einzelnen Plattformkomponente zugeschrieben werden.",
        "",
    ])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    if manifest.get("experiment") != "E3" or manifest.get("variant") != "haw_target_replication":
        raise SystemExit("Manifest ist kein E3-HAW-Lauf")
    if not manifest.get("guardrail_unchanged"):
        raise SystemExit("Manifest bestaetigt keinen unveraenderten Guardrail")
    if manifest.get("baseline_plugin_commit") != manifest.get("measurement_plugin_commit"):
        raise SystemExit("Baseline- und Mess-Commit unterscheiden sich")
    expected_rounds = int(manifest["schedule"]["rounds"])
    if not manifest.get("completed") or manifest.get("completed_rounds") != expected_rounds:
        raise SystemExit("E3-HAW-Lauf ist nicht vollstaendig")

    round_data: list[dict[str, Any]] = []
    seen_rounds: set[int] = set()
    expected_evaluations = int(manifest["schedule"]["evaluations_per_round"])
    for entry in manifest.get("rounds", []):
        round_number = int(entry["round"])
        if round_number in seen_rounds:
            raise SystemExit(f"doppelte Runde im Manifest: {round_number}")
        seen_rounds.add(round_number)
        path = Path(entry["file"])
        if not path.exists():
            # Transfer auf ein anderes Betriebssystem: relativ zum Manifest suchen.
            path = args.manifest.parent / Path(entry["file"]).name
        if not path.exists():
            raise SystemExit(f"Rundendatei fehlt: {entry['file']}")
        if sha256(path) != entry["sha256"]:
            raise SystemExit(f"SHA-256 abweichend: {path}")
        data = load_json(path)
        if data.get("meta", {}).get("total_evaluations") != expected_evaluations:
            raise SystemExit(f"unvollstaendige Runde: {path}")
        for layer in ("overall_self", "overall_wall"):
            if data.get(layer, {}).get("n") != expected_evaluations:
                raise SystemExit(f"unvollstaendige {layer}-Daten: {path}")
        round_data.append(data)

    if seen_rounds != set(range(1, expected_rounds + 1)):
        raise SystemExit("Rundenmenge ist nicht vollstaendig")

    aggregate = {
        "overall_self": aggregate_layers(round_data, "overall_self"),
        "overall_wall": aggregate_layers(round_data, "overall_wall"),
    }
    class_names = set(round_data[0].get("by_class_self", {}))
    if not class_names or any(set(item.get("by_class_self", {})) != class_names for item in round_data):
        raise SystemExit("Risikoklassen unterscheiden sich zwischen den Runden")
    aggregate["by_class_self"] = {
        class_name: aggregate_layers(
            [{"class_summary": item["by_class_self"][class_name]} for item in round_data],
            "class_summary",
        )
        for class_name in sorted(class_names)
    }
    summary: dict[str, Any] = {
        "experiment": "E3",
        "title": "Policy-Latenz auf dem HAW-Zielsystem",
        "manifest": manifest,
        "validation": {
            "rounds": len(round_data),
            "evaluations_per_round": expected_evaluations,
            "evaluations_total": expected_evaluations * len(round_data),
            "round_hashes_verified": True,
            "guardrail_hashes_frozen": True,
        },
        "aggregate": aggregate,
    }
    if args.baseline and args.baseline.exists():
        baseline = load_json(args.baseline)
        summary["comparison_to_windows"] = compare_baseline(baseline, aggregate)

    atomic_json(args.summary, summary)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(build_report(summary), encoding="utf-8")
    print(
        f"E3-HAW validiert: {len(round_data)}/{expected_rounds} Runden, "
        f"{expected_evaluations * len(round_data):,} Auswertungen"
    )
    print(f"Summary: {args.summary}")
    print(f"Report:  {args.report}")


if __name__ == "__main__":
    main()
