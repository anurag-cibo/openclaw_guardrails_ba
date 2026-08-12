#!/usr/bin/env bash
# E3-Zielsystem-Replikation auf dem HAW-Host.
#
# Der Host besitzt kein Node. Der Runner verwendet deshalb das bereits laufende
# Gateway-Image, jedoch mit --network none: E3 benoetigt weder OpenClaw noch
# Ollama. --sig-proxy=false und ein aeusseres setsid schuetzen den Lauf vor dem
# Abbruch der SSH-Verbindung.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXP="$(cd "$HERE/.." && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$EXP/.." && pwd)}"
DATA="$EXP/results/data"
RESULT_ROOT="$DATA/lab/e3"
EVAL="$EXP/docs/evaluations/e3"
STAMP="$(date +%Y%m%d_%H%M%S)"
RUNDIR="$DATA/runs/operational/$STAMP"
mkdir -p "$RUNDIR"
LOG="$RUNDIR/E3_haw.log"

OPENCLAW_REPO="${OPENCLAW_REPO:?OPENCLAW_REPO muss als absoluter Pfad gesetzt sein}"
E3_ROUNDS="${E3_ROUNDS:-5}"
E3_ITERATIONS="${E3_ITERATIONS:-3000}"
E3_RESUME="${E3_RESUME:-0}"
PILOT="${PILOT:-0}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
E3_SKIP_PACKAGE="${E3_SKIP_PACKAGE:-0}"

BASELINE_PLUGIN_COMMIT="${BASELINE_PLUGIN_COMMIT:-9219828}"
MEASUREMENT_PLUGIN_COMMIT="${MEASUREMENT_PLUGIN_COMMIT:-$BASELINE_PLUGIN_COMMIT}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.5.18}"
HOST_HARDWARE="${HOST_HARDWARE:-HAW-Uni-Host / GRID V100S-32Q}"

EXPECTED_POLICY_SHA256="${EXPECTED_POLICY_SHA256:-8aedb313377f3a07d8d6e600b7b647e7996ad9c09332f3cc9c688f783a24e049}"
EXPECTED_JUDGE_SHA256="${EXPECTED_JUDGE_SHA256:-e0afaa9ee0ae3f7802dc5e9b2ed2b21e25a606b017fee5574755051135746286}"
EXPECTED_INDEX_SHA256="${EXPECTED_INDEX_SHA256:-ad4f7b1dcdb99a7bfd5b68fddf5b03e12bcbc42e42f98a07901bf871fc9292e0}"
EXPECTED_CORPUS_SHA256="${EXPECTED_CORPUS_SHA256:-76774d8a80c583a8116ec9c4831c0ecbd93f306c92837827eeae2a0380bb1ffb}"
EXPECTED_BENCHMARK_SHA256="${EXPECTED_BENCHMARK_SHA256:-99bcc72f7b62f0c9d17e0407d13936b4941c94513e904887235531034e4c07df}"

RUNNER="$EXP/harness/run_e3_haw.mjs"
ANALYZER="$EXP/results/analysis/e3/analyze_e3_haw.py"
CORPUS="$EXP/corpus/policy_corpus.jsonl"
BENCHMARK="$EXP/harness/bench_policy_latency.mjs"
BASELINE="$RESULT_ROOT/E3_latency.json"

if [ "$PILOT" = "1" ]; then
  OUT="$RUNDIR/e3_haw_pilot"
  MANIFEST="$OUT/E3_haw_manifest.json"
  SUMMARY="$RUNDIR/E3_haw_PILOT_summary.json"
  REPORT="$RUNDIR/E3_haw_PILOT_report.md"
  E3_ROUNDS="${E3_PILOT_ROUNDS:-1}"
  E3_ITERATIONS="${E3_PILOT_ITERATIONS:-20}"
  E3_PILOT=1
else
  OUT="${E3_OUT_DIR:-$RESULT_ROOT/haw}"
  MANIFEST="${E3_MANIFEST:-$OUT/E3_haw_manifest.json}"
  SUMMARY="${E3_SUMMARY:-$EVAL/E3_haw_summary.json}"
  REPORT="${E3_REPORT:-$EVAL/E3_haw_report.md}"
  E3_PILOT=0
fi

say() {
  local line
  line="[$(date +%H:%M:%S)] $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$LOG"
}

say "E3-HAW Start: pilot=$PILOT resume=$E3_RESUME"
say "Plan: rounds=$E3_ROUNDS iterations=$E3_ITERATIONS corpus=116"
say "Guardrail unveraendert: baseline=$BASELINE_PLUGIN_COMMIT measurement=$MEASUREMENT_PLUGIN_COMMIT"

fail=0
for file in "$RUNNER" "$ANALYZER" "$BENCHMARK" "$CORPUS" "$BASELINE"; do
  if [ -f "$file" ]; then say "gefunden: ${file#$EXP/}"
  else say "FEHLT: ${file#$EXP/}"; fail=1; fi
done

if [ -z "${GUARDRAIL_SRC:-}" ]; then
  for candidate in \
    "$PROJECT_ROOT/guardrail-plugin/openclaw_guardrails_ba/src" \
    "$PROJECT_ROOT/guardrail-plugin/src" \
    "$EXP/../guardrail-plugin/openclaw_guardrails_ba/src"
  do
    if [ -f "$candidate/policy.js" ] && [ -f "$candidate/judge.js" ] && [ -f "$candidate/index.js" ]; then
      GUARDRAIL_SRC="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi
if [ -n "${GUARDRAIL_SRC:-}" ]; then
  say "Plugin-Quelle: $GUARDRAIL_SRC"
else
  say "FEHLT: Guardrail-Quelle; GUARDRAIL_SRC setzen"
  fail=1
fi
export GUARDRAIL_SRC="${GUARDRAIL_SRC:-}"

if [ "$BASELINE_PLUGIN_COMMIT" != "$MEASUREMENT_PLUGIN_COMMIT" ]; then
  say "ABBRUCH: Guardrail-Commit darf fuer E3-HAW nicht abweichen"
  fail=1
fi
[ "$fail" = "1" ] && { say "Preflight fehlgeschlagen"; exit 2; }

PLUGIN_ROOT="$(cd "$GUARDRAIL_SRC/.." && pwd)"
PLUGIN_COMMIT_FULL=""
if command -v git >/dev/null 2>&1 && git -C "$PLUGIN_ROOT" rev-parse HEAD >/dev/null 2>&1; then
  PLUGIN_COMMIT_FULL="$(git -C "$PLUGIN_ROOT" rev-parse HEAD)"
  case "$PLUGIN_COMMIT_FULL" in
    "$BASELINE_PLUGIN_COMMIT"*) say "Plugin-Commit verifiziert: $PLUGIN_COMMIT_FULL" ;;
    *) say "ABBRUCH: Git-Commit $PLUGIN_COMMIT_FULL entspricht nicht $BASELINE_PLUGIN_COMMIT"; exit 2 ;;
  esac
else
  say "Git-Commit nicht lesbar; die drei Guardrail-Hashes bleiben zwingend"
fi

resolve_gateway_container() {
  docker compose -f "$OPENCLAW_REPO/docker-compose.yml" \
    -f "$OPENCLAW_REPO/docker-compose.ollama.override.yml" \
    ps -q openclaw-gateway 2>/dev/null | head -1
}

GATEWAY_CONTAINER="$(resolve_gateway_container)"
if [ -z "$GATEWAY_CONTAINER" ]; then
  say "ABBRUCH: laufender Gateway-Container nicht gefunden"
  exit 2
fi
GATEWAY_IMAGE="${GATEWAY_IMAGE:-$(docker inspect --format '{{.Config.Image}}' "$GATEWAY_CONTAINER")}"
GATEWAY_IMAGE_ID="${GATEWAY_IMAGE_ID:-$(docker inspect --format '{{.Image}}' "$GATEWAY_CONTAINER")}"
say "Gateway-Image: $GATEWAY_IMAGE"
say "Gateway-Image-ID: $GATEWAY_IMAGE_ID"

mkdir -p "$OUT"

start="$(date +%s)"
say "Node-Runner startet ohne Netzwerkzugriff"
if docker run --rm --sig-proxy=false \
  --network none \
  -v "$PROJECT_ROOT":"$PROJECT_ROOT" \
  -w "$EXP" \
  --user "$(id -u):$(id -g)" \
  -e E3_ROUNDS="$E3_ROUNDS" \
  -e E3_ITERATIONS="$E3_ITERATIONS" \
  -e E3_RESUME="$E3_RESUME" \
  -e E3_PILOT="$E3_PILOT" \
  -e E3_OUT_DIR="$OUT" \
  -e E3_MANIFEST="$MANIFEST" \
  -e E3_CORPUS="$CORPUS" \
  -e E3_BENCHMARK="$BENCHMARK" \
  -e E3_EXPECT_PLATFORM=linux \
  -e E3_EXPECT_ARCH=x64 \
  -e GUARDRAIL_SRC="$GUARDRAIL_SRC" \
  -e BASELINE_PLUGIN_COMMIT="$BASELINE_PLUGIN_COMMIT" \
  -e MEASUREMENT_PLUGIN_COMMIT="$MEASUREMENT_PLUGIN_COMMIT" \
  -e PLUGIN_COMMIT_FULL="$PLUGIN_COMMIT_FULL" \
  -e EXPECTED_POLICY_SHA256="$EXPECTED_POLICY_SHA256" \
  -e EXPECTED_JUDGE_SHA256="$EXPECTED_JUDGE_SHA256" \
  -e EXPECTED_INDEX_SHA256="$EXPECTED_INDEX_SHA256" \
  -e EXPECTED_CORPUS_SHA256="$EXPECTED_CORPUS_SHA256" \
  -e EXPECTED_BENCHMARK_SHA256="$EXPECTED_BENCHMARK_SHA256" \
  -e GATEWAY_IMAGE="$GATEWAY_IMAGE" \
  -e GATEWAY_IMAGE_ID="$GATEWAY_IMAGE_ID" \
  -e OPENCLAW_VERSION="$OPENCLAW_VERSION" \
  -e HOST_HARDWARE="$HOST_HARDWARE" \
  "$GATEWAY_IMAGE" node "$RUNNER" >>"$LOG" 2>&1
then
  status=ok
else
  code=$?
  status="FAILED(exit=$code)"
fi
end="$(date +%s)"
say "Runner: $status nach $((end - start)) s"
[ "$status" = "ok" ] || exit 3

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  say "ABBRUCH: Python nicht gefunden ($PYTHON_BIN); Rohdaten bleiben erhalten"
  exit 4
fi

say "Validierung und Auswertung starten"
if "$PYTHON_BIN" "$ANALYZER" \
  --manifest "$MANIFEST" \
  --baseline "$BASELINE" \
  --summary "$SUMMARY" \
  --report "$REPORT" >>"$LOG" 2>&1
then
  say "Auswertung erfolgreich"
else
  say "Auswertung fehlgeschlagen; Rohdaten bleiben erhalten"
  exit 5
fi

if [ "$E3_SKIP_PACKAGE" != "1" ]; then
  TAR="/tmp/haw_e3_${STAMP}.tar.gz"
  files="${OUT#$EXP/} ${SUMMARY#$EXP/} ${REPORT#$EXP/} results/data/runs/operational/$STAMP"
  (cd "$EXP" && tar czf "$TAR" $files)
  say "Paket: $TAR ($(du -h "$TAR" 2>/dev/null | cut -f1))"
fi
say "Rohdaten: $OUT"
say "Summary: $SUMMARY"
say "Report: $REPORT"
say "Log: $LOG"
