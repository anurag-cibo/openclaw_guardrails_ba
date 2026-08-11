#!/usr/bin/env bash
# E8.2 auf dem HAW-Host: Node aus dem Gateway-Image, Ollama im Compose-Netz.
# Der Guardrail bleibt unveraendert; Telemetrie wird im Runner per fetch-Wrapper
# mitgelesen. Fuer SSH-Festigkeit den Wrapper immer mit setsid starten. Der
# darin verwendete Docker-Client setzt zusaetzlich --sig-proxy=false.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXP="$(cd "$HERE/.." && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$EXP/.." && pwd)}"
DATA="$EXP/results/data"
RES="$DATA/lab/e8"
EVAL="$EXP/docs/evaluations/e8"
STAMP="$(date +%Y%m%d_%H%M%S)"
RUNDIR="$DATA/runs/operational/$STAMP"
mkdir -p "$RUNDIR"
LOG="$RUNDIR/E8_2.log"

OPENCLAW_REPO="${OPENCLAW_REPO:?OPENCLAW_REPO muss als absoluter Pfad gesetzt sein}"
DOCKER_NETWORK="${DOCKER_NETWORK:-openclaw_default}"
JUDGE_BASE_URL="${JUDGE_BASE_URL:-http://ollama:11434}"
JUDGE_MODELS="${JUDGE_MODELS:-qwen3:30b}"
JUDGE_TIMEOUT_MS="${JUDGE_TIMEOUT_MS:-60000}"
E8_BASE_REPS="${E8_BASE_REPS:-3}"
E8_STABILITY_N="${E8_STABILITY_N:-60}"
E8_STABILITY_TOTAL_REPS="${E8_STABILITY_TOTAL_REPS:-5}"
E8_SEED="${E8_SEED:-42}"
E8_RESUME="${E8_RESUME:-0}"
PILOT="${PILOT:-0}"
JUDGE_MOCK="${JUDGE_MOCK:-0}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
E8_SKIP_PACKAGE="${E8_SKIP_PACKAGE:-0}"

BASELINE_PLUGIN_COMMIT="${BASELINE_PLUGIN_COMMIT:-9219828}"
# E8.2 darf keinen abweichenden Guardrail messen. Der Node-Runner erzwingt
# Gleichheit nochmals und schreibt Hashes von policy.js/judge.js ins Manifest.
MEASUREMENT_PLUGIN_COMMIT="${MEASUREMENT_PLUGIN_COMMIT:-$BASELINE_PLUGIN_COMMIT}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.5.18}"
AGENT_MODEL="${AGENT_MODEL:-qwen3:30b}"
GPU_HARDWARE="${GPU_HARDWARE:-GRID V100S-32Q}"
EXPECTED_POLICY_SHA256="${EXPECTED_POLICY_SHA256:-8aedb313377f3a07d8d6e600b7b647e7996ad9c09332f3cc9c688f783a24e049}"
EXPECTED_JUDGE_SHA256="${EXPECTED_JUDGE_SHA256:-e0afaa9ee0ae3f7802dc5e9b2ed2b21e25a606b017fee5574755051135746286}"

RUNNER="$EXP/harness/run_aegish_judge.mjs"
ANALYZER="$EXP/results/analysis/e8/analyze_e8_2.py"
DATA_DIR="$EXP/corpus/external/aegish"
POLICY_RESULTS="$RES/E8_1_aegish_policy_results.jsonl"

if [ "$PILOT" = "1" ]; then
  OUT="$RUNDIR/E8_2_aegish_judge_PILOT.jsonl"
  MANIFEST="$RUNDIR/E8_2_aegish_judge_PILOT_manifest.json"
  SAMPLE="$RES/E8_2_stability_sample.json"
  E8_PILOT=1
else
  OUT="${E8_OUT:-$RES/E8_2_aegish_judge_results.jsonl}"
  MANIFEST="${E8_MANIFEST:-$RES/E8_2_aegish_judge_manifest.json}"
  SAMPLE="${E8_SAMPLE_FILE:-$RES/E8_2_stability_sample.json}"
  E8_PILOT=0
fi

say() {
  line="[$(date +%H:%M:%S)] $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$LOG"
}

say "E8.2 Start: pilot=$PILOT mock=$JUDGE_MOCK resume=$E8_RESUME"
say "Plan: base_reps=$E8_BASE_REPS stability_n=$E8_STABILITY_N stability_total=$E8_STABILITY_TOTAL_REPS"
say "Judge: $JUDGE_MODELS via $JUDGE_BASE_URL timeout=${JUDGE_TIMEOUT_MS}ms"
say "Guardrail unveraendert: baseline=$BASELINE_PLUGIN_COMMIT measurement=$MEASUREMENT_PLUGIN_COMMIT"

fail=0
for file in \
  "$RUNNER" "$ANALYZER" "$POLICY_RESULTS" \
  "$DATA_DIR/PROVENANCE.json" \
  "$DATA_DIR/gtfobins_commands.json" \
  "$DATA_DIR/harmless_commands.json"
do
  if [ -f "$file" ]; then say "gefunden: ${file#$EXP/}"
  else say "FEHLT: ${file#$EXP/}"; fail=1; fi
done

if [ -z "${GUARDRAIL_SRC:-}" ]; then
  for candidate in \
    "$PROJECT_ROOT/guardrail-plugin/openclaw_guardrails_ba/src" \
    "$PROJECT_ROOT/guardrail-plugin/src" \
    "$EXP/../guardrail-plugin/src"
  do
    if [ -f "$candidate/policy.js" ] && [ -f "$candidate/judge.js" ]; then
      GUARDRAIL_SRC="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi
if [ -n "${GUARDRAIL_SRC:-}" ] && [ -f "$GUARDRAIL_SRC/judge.js" ]; then
  say "Plugin-Quelle: $GUARDRAIL_SRC"
else
  say "FEHLT: policy.js/judge.js; GUARDRAIL_SRC setzen"
  fail=1
fi
export GUARDRAIL_SRC="${GUARDRAIL_SRC:-}"

if [ "$BASELINE_PLUGIN_COMMIT" != "$MEASUREMENT_PLUGIN_COMMIT" ]; then
  say "ABBRUCH: Guardrail-Commit darf fuer E8.2 nicht abweichen"
  fail=1
fi
if [ "$PILOT" != "1" ] && [ "$E8_RESUME" != "1" ]; then
  [ -s "$OUT" ] && { say "ABBRUCH: Ergebnis existiert bereits: $OUT"; fail=1; }
  [ -s "$MANIFEST" ] && { say "ABBRUCH: Manifest existiert bereits: $MANIFEST"; fail=1; }
fi
[ "$fail" = "1" ] && { say "Preflight fehlgeschlagen"; exit 2; }

resolve_gateway_image() {
  local cid
  cid=$(docker compose -f "$OPENCLAW_REPO/docker-compose.yml" \
        -f "$OPENCLAW_REPO/docker-compose.ollama.override.yml" \
        ps -q openclaw-gateway 2>/dev/null | head -1)
  [ -n "$cid" ] || return 1
  docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null
}

GATEWAY_IMAGE="${GATEWAY_IMAGE:-}"
node_run() {
  if command -v node >/dev/null 2>&1; then
    env \
      AEGISH_DATA_DIR="$DATA_DIR" E8_OUT="$OUT" E8_MANIFEST="$MANIFEST" E8_SAMPLE_FILE="$SAMPLE" \
      E8_BASE_REPS="$E8_BASE_REPS" E8_STABILITY_N="$E8_STABILITY_N" \
      E8_STABILITY_TOTAL_REPS="$E8_STABILITY_TOTAL_REPS" E8_SEED="$E8_SEED" \
      E8_RESUME="$E8_RESUME" E8_PILOT="$E8_PILOT" \
      JUDGE_BASE_URL="$JUDGE_BASE_URL" JUDGE_MODELS="$JUDGE_MODELS" \
      JUDGE_TIMEOUT_MS="$JUDGE_TIMEOUT_MS" JUDGE_MOCK="$JUDGE_MOCK" \
      GUARDRAIL_SRC="$GUARDRAIL_SRC" \
      BASELINE_PLUGIN_COMMIT="$BASELINE_PLUGIN_COMMIT" \
      MEASUREMENT_PLUGIN_COMMIT="$MEASUREMENT_PLUGIN_COMMIT" \
      OPENCLAW_VERSION="$OPENCLAW_VERSION" AGENT_MODEL="$AGENT_MODEL" GPU_HARDWARE="$GPU_HARDWARE" \
      EXPECTED_POLICY_SHA256="$EXPECTED_POLICY_SHA256" EXPECTED_JUDGE_SHA256="$EXPECTED_JUDGE_SHA256" \
      node "$@"
    return $?
  fi

  if [ -z "$GATEWAY_IMAGE" ]; then
    GATEWAY_IMAGE=$(resolve_gateway_image) || {
      say "node fehlt und Gateway-Image nicht ermittelbar"; return 127; }
    say "Gateway-Image: $GATEWAY_IMAGE (Netz $DOCKER_NETWORK)"
  fi

  docker run --rm --sig-proxy=false \
    --network "$DOCKER_NETWORK" \
    -v "$PROJECT_ROOT":"$PROJECT_ROOT" \
    -w "$EXP" \
    -e AEGISH_DATA_DIR="$DATA_DIR" \
    -e E8_OUT="$OUT" -e E8_MANIFEST="$MANIFEST" -e E8_SAMPLE_FILE="$SAMPLE" \
    -e E8_BASE_REPS="$E8_BASE_REPS" -e E8_STABILITY_N="$E8_STABILITY_N" \
    -e E8_STABILITY_TOTAL_REPS="$E8_STABILITY_TOTAL_REPS" -e E8_SEED="$E8_SEED" \
    -e E8_RESUME="$E8_RESUME" -e E8_PILOT="$E8_PILOT" \
    -e JUDGE_BASE_URL="$JUDGE_BASE_URL" -e JUDGE_MODELS="$JUDGE_MODELS" \
    -e JUDGE_TIMEOUT_MS="$JUDGE_TIMEOUT_MS" -e JUDGE_MOCK="$JUDGE_MOCK" \
    -e GUARDRAIL_SRC="$GUARDRAIL_SRC" \
    -e BASELINE_PLUGIN_COMMIT="$BASELINE_PLUGIN_COMMIT" \
    -e MEASUREMENT_PLUGIN_COMMIT="$MEASUREMENT_PLUGIN_COMMIT" \
    -e OPENCLAW_VERSION="$OPENCLAW_VERSION" -e AGENT_MODEL="$AGENT_MODEL" \
    -e GPU_HARDWARE="$GPU_HARDWARE" \
    -e EXPECTED_POLICY_SHA256="$EXPECTED_POLICY_SHA256" \
    -e EXPECTED_JUDGE_SHA256="$EXPECTED_JUDGE_SHA256" \
    --user "$(id -u):$(id -g)" \
    "$GATEWAY_IMAGE" node "$@"
}

start=$(date +%s)
say "Node-Runner startet; Ollama-/Modell-Preflight erfolgt aus derselben Netzwerksicht"
if node_run "$RUNNER" "$OUT" "$MANIFEST" "$SAMPLE" >>"$LOG" 2>&1; then
  status=ok
else
  code=$?
  status="FAILED(exit=$code)"
fi
end=$(date +%s)
say "Runner: $status nach $(( (end - start) / 60 )) min"
[ "$status" = "ok" ] || exit 3

if [ "$PILOT" = "1" ]; then
  # Der Pilot ist nur ein Pipeline-Nachweis. Token-Capture muss funktionieren.
  command -v "$PYTHON_BIN" >/dev/null 2>&1 \
    || { say "PILOT FEHLER: Python nicht gefunden ($PYTHON_BIN)"; exit 4; }
  token_rows=$("$PYTHON_BIN" - "$OUT" <<'PY'
import json, sys
rows = [json.loads(x) for x in open(sys.argv[1], encoding="utf-8") if x.strip()]
print(sum(r.get("judge_total_tokens") is not None for r in rows))
PY
)
  say "PILOT: Token-Telemetrie in $token_rows/6 Zeilen vorhanden"
  [ "$token_rows" -eq 6 ] || { say "PILOT FEHLER: Token-Capture unvollstaendig"; exit 4; }
  say "PILOT erfolgreich; Zahlen nicht als Ergebnis verwenden"
else
  if command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    say "Auswertung startet"
    "$PYTHON_BIN" "$ANALYZER" \
      --judge "$OUT" --manifest "$MANIFEST" --policy "$POLICY_RESULTS" \
      --sample "$SAMPLE" \
      --summary "$EVAL/E8_2_aegish_judge_summary.json" \
      --report "$EVAL/E8_2_aegish_judge_report.md" >>"$LOG" 2>&1 \
      || { say "Auswertung fehlgeschlagen; Rohdaten bleiben erhalten"; exit 5; }
    say "Auswertung erfolgreich"
  else
    say "python3 fehlt; Auswertung nach Transfer lokal ausfuehren"
  fi
fi

if [ "$E8_SKIP_PACKAGE" != "1" ]; then
  TAR="/tmp/haw_e8_2_${STAMP}.tar.gz"
  files="${OUT#$EXP/} ${MANIFEST#$EXP/} results/data/runs/operational/$STAMP"
  [ -f "$SAMPLE" ] && files="$files ${SAMPLE#$EXP/}"
  [ -f "$EVAL/E8_2_aegish_judge_summary.json" ] && files="$files docs/evaluations/e8/E8_2_aegish_judge_summary.json"
  [ -f "$EVAL/E8_2_aegish_judge_report.md" ] && files="$files docs/evaluations/e8/E8_2_aegish_judge_report.md"
  ( cd "$EXP" && tar czf "$TAR" $files )
  say "Paket: $TAR ($(du -h "$TAR" 2>/dev/null | cut -f1))"
fi
say "Log: $LOG"
