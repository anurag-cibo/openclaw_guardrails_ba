#!/usr/bin/env bash
# E5ext: 60 unabhaengige harmlose aegish-Faelle durch den realen
# OpenClaw-Agenten-/Core-exec-Pfad in C0..C3. Der Guardrail-Code bleibt
# unveraendert. Alle Kommandos sind read-only; ein gemeinsames Fixture wird
# vor jedem Lauf gesichert aufgebaut und danach wiederhergestellt.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXP="$(cd "$HERE/.." && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$EXP/.." && pwd)}"
DATA="$EXP/results/data"
STAMP="$(date +%Y%m%d_%H%M%S)"
RUNDIR="$DATA/runs/operational/$STAMP"
mkdir -p "$RUNDIR"
LOG="$RUNDIR/E5ext.log"

OPENCLAW_REPO="${OPENCLAW_REPO:?OPENCLAW_REPO muss als absoluter Pfad gesetzt sein}"
CORPUS="$EXP/corpus/e5ext_aegish_live.jsonl"
ELIGIBILITY_AUDIT="$EXP/corpus/e5ext_aegish_eligibility.jsonl"
SAMPLE_MANIFEST="$EXP/corpus/e5ext_aegish_sample_manifest.json"
FIXTURE_MANAGER="$HERE/e5ext_fixture.mjs"
EVALUATOR="$HERE/evaluate_e5ext_run.py"
MANIFEST_TOOL="$HERE/e5ext_manifest.py"
ANALYZER="$EXP/results/analysis/e5ext/analyze_e5ext.py"
SETUP_LAB="$HERE/setup_lab.sh"
APPROVAL_RESPONDER="$HERE/approval_responder.py"

CONFIGS="C0 C1 C2 C3"
MODEL="${MODEL:-qwen3:30b}"
JUDGE_MODEL="${JUDGE_MODEL:-qwen3:30b}"
JUDGE_BASE_URL="${JUDGE_BASE_URL:-http://ollama:11434}"
JUDGE_TIMEOUT_MS="${JUDGE_TIMEOUT_MS:-60000}"
PILOT="${PILOT:-0}"
E5EXT_RESUME="${E5EXT_RESUME:-0}"
C3_APPROVAL_POLICY="deny"
APPROVAL_MAX_SECONDS="${APPROVAL_MAX_SECONDS:-900}"
BASELINE_PLUGIN_COMMIT="${BASELINE_PLUGIN_COMMIT:-9219828}"
MEASUREMENT_PLUGIN_COMMIT="${MEASUREMENT_PLUGIN_COMMIT:-$BASELINE_PLUGIN_COMMIT}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.5.18}"
HOST_HARDWARE="${HOST_HARDWARE:-HAW-Uni-Host / GRID V100S-32Q}"
E5EXT_SKIP_PACKAGE="${E5EXT_SKIP_PACKAGE:-0}"

PILOT_IDS="AEG-H-0013 AEG-H-0015 AEG-H-0024 AEG-H-0341 AEG-H-0403 AEG-H-0480"
if [ "$PILOT" = "1" ]; then
  REPS=1
  CASE_IDS="$PILOT_IDS"
  CASE_COUNT=6
  OUTDIR="$RUNDIR/e5ext_pilot"
  SUMMARY="$RUNDIR/E5ext_PILOT_summary.json"
  REPORT="$RUNDIR/E5ext_PILOT_report.md"
else
  REPS=3
  CASE_IDS=""
  CASE_COUNT=60
  OUTDIR="${E5EXT_OUTDIR:-$DATA/live/e5ext}"
  SUMMARY="${E5EXT_SUMMARY:-$EXP/docs/evaluations/e5ext/E5ext_summary.json}"
  REPORT="${E5EXT_REPORT:-$EXP/docs/evaluations/e5ext/E5ext_report.md}"
fi
RAWDIR="$OUTDIR/raw"
RUNS_OUT="$OUTDIR/E5ext_live_runs.jsonl"
MANIFEST="$OUTDIR/E5ext_manifest.json"
EXPECTED_ROWS=$((CASE_COUNT * 4 * REPS))
mkdir -p "$OUTDIR" "$RAWDIR"

dc() { docker compose -f "$OPENCLAW_REPO/docker-compose.yml" -f "$OPENCLAW_REPO/docker-compose.ollama.override.yml" "$@"; }
occ() { dc exec -T openclaw-gateway sh -lc "$1"; }
say() { local line="[$(date +%H:%M:%S)] $*"; printf '%s\n' "$line"; printf '%s\n' "$line" >>"$LOG"; }

say "E5ext Start: pilot=$PILOT resume=$E5EXT_RESUME expected=$EXPECTED_ROWS"
say "Modelle: agent=$MODEL judge=$JUDGE_MODEL via $JUDGE_BASE_URL timeout=${JUDGE_TIMEOUT_MS}ms"
say "Guardrail unveraendert: baseline=$BASELINE_PLUGIN_COMMIT measurement=$MEASUREMENT_PLUGIN_COMMIT"

for file in "$CORPUS" "$ELIGIBILITY_AUDIT" "$SAMPLE_MANIFEST" "$FIXTURE_MANAGER" "$EVALUATOR" \
  "$MANIFEST_TOOL" "$ANALYZER" "$SETUP_LAB" "$APPROVAL_RESPONDER"; do
  [ -f "$file" ] || { say "FEHLT: ${file#$EXP/}"; exit 2; }
done
[ "$BASELINE_PLUGIN_COMMIT" = "$MEASUREMENT_PLUGIN_COMMIT" ] \
  || { say "ABBRUCH: Guardrail-Commit darf nicht abweichen"; exit 2; }

if [ -z "${GUARDRAIL_SRC:-}" ]; then
  for candidate in \
    "$PROJECT_ROOT/guardrail-plugin/openclaw_guardrails_ba/src" \
    "$PROJECT_ROOT/guardrail-plugin/src" \
    "$EXP/../guardrail-plugin/src"
  do
    if [ -f "$candidate/policy.js" ] && [ -f "$candidate/judge.js" ] && [ -f "$candidate/index.js" ]; then
      GUARDRAIL_SRC="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi
[ -n "${GUARDRAIL_SRC:-}" ] || { say "Guardrail-Quelle nicht gefunden"; exit 2; }
say "Plugin-Quelle: $GUARDRAIL_SRC"

PLUGIN_ROOT="$(cd "$GUARDRAIL_SRC/.." && pwd)"
PLUGIN_COMMIT_FULL=""
if command -v git >/dev/null 2>&1 && git -C "$PLUGIN_ROOT" rev-parse HEAD >/dev/null 2>&1; then
  PLUGIN_COMMIT_FULL="$(git -C "$PLUGIN_ROOT" rev-parse HEAD)"
  case "$PLUGIN_COMMIT_FULL" in
    "$BASELINE_PLUGIN_COMMIT"*) say "Plugin-Commit verifiziert: $PLUGIN_COMMIT_FULL" ;;
    *) say "ABBRUCH: falscher Plugin-Commit $PLUGIN_COMMIT_FULL"; exit 2 ;;
  esac
fi

GATEWAY_CONTAINER="$(dc ps -q openclaw-gateway | head -1)"
[ -n "$GATEWAY_CONTAINER" ] || { say "laufender Gateway-Container fehlt"; exit 2; }
GATEWAY_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$GATEWAY_CONTAINER")"
GATEWAY_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$GATEWAY_CONTAINER")"
say "Gateway-Image: $GATEWAY_IMAGE ($GATEWAY_IMAGE_ID)"

REQUIRED_COMMANDS="awk base64 cat cut date df du echo find grep head ls node ps sed sort tail tr uname uniq wc xargs"
missing_commands="$(occ "for command_name in $REQUIRED_COMMANDS; do command -v \"\$command_name\" >/dev/null 2>&1 || printf '%s ' \"\$command_name\"; done")"
[ -z "$missing_commands" ] || { say "ABBRUCH: Gateway-Kommandos fehlen: $missing_commands"; exit 2; }
say "Gateway-Kommandos verifiziert: $REQUIRED_COMMANDS"

manifest_args=(
  init --manifest "$MANIFEST" --results "$RUNS_OUT" --corpus "$CORPUS" --audit "$ELIGIBILITY_AUDIT"
  --sample-manifest "$SAMPLE_MANIFEST" --guardrail-src "$GUARDRAIL_SRC"
  --runner "$HERE/run_e5ext.sh" --evaluator "$EVALUATOR" --fixture "$FIXTURE_MANAGER"
  --analyzer "$ANALYZER" --configs "$CONFIGS" --reps "$REPS" --case-count "$CASE_COUNT"
  --case-ids "$CASE_IDS" --expected-rows "$EXPECTED_ROWS" --agent-model "$MODEL"
  --judge-model "$JUDGE_MODEL" --judge-base-url "$JUDGE_BASE_URL"
  --judge-timeout-ms "$JUDGE_TIMEOUT_MS"
  --openclaw-version "$OPENCLAW_VERSION" --baseline-commit "$BASELINE_PLUGIN_COMMIT"
  --measurement-commit "$MEASUREMENT_PLUGIN_COMMIT" --plugin-commit-full "$PLUGIN_COMMIT_FULL"
  --gateway-image "$GATEWAY_IMAGE" --gateway-image-id "$GATEWAY_IMAGE_ID"
  --host-hardware "$HOST_HARDWARE"
)
[ "$PILOT" = "1" ] && manifest_args+=(--pilot)
[ "$E5EXT_RESUME" = "1" ] && manifest_args+=(--resume)
python3 "$MANIFEST_TOOL" "${manifest_args[@]}" >>"$LOG"

if [ "$E5EXT_RESUME" != "1" ]; then
  : >"$RUNS_OUT"
fi

fixture_action() {
  local action="$1"
  dc exec -T -e E5EXT_FIXTURE_ACTION="$action" openclaw-gateway node - <"$FIXTURE_MANAGER"
}

active_responder=""
cleanup() {
  set +e
  if [ -n "$active_responder" ]; then kill "$active_responder" 2>/dev/null; wait "$active_responder" 2>/dev/null; fi
  fixture_action cleanup >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
fixture_action recover >/dev/null

apply_config() {
  local cfg="$1" mode judge_enabled judge_fallback hitl_enabled approval_enabled
  case "$cfg" in
    C0) mode=observe; judge_enabled=false; judge_fallback=block; hitl_enabled=false; approval_enabled=false ;;
    C1) mode=enforce; judge_enabled=false; judge_fallback=block; hitl_enabled=false; approval_enabled=false ;;
    C2) mode=enforce; judge_enabled=true; judge_fallback=block; hitl_enabled=false; approval_enabled=false ;;
    C3) mode=enforce; judge_enabled=true; judge_fallback=require_approval; hitl_enabled=true; approval_enabled=true ;;
    *) return 2 ;;
  esac
  say "wende Konfiguration $cfg an"
  occ "openclaw config set plugins.entries.guardrail-spike.enabled true --strict-json" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.mode $mode" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.protectedTargets '[\"guardrail-lab\"]' --strict-json" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.approvalTargets '[\"guardrail-lab/tmp\"]' --strict-json" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.resolveSymlinks true --strict-json" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.escalateFallback block" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.judge.enabled $judge_enabled --strict-json" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.judge.model $JUDGE_MODEL" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.judge.baseUrl $JUDGE_BASE_URL" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.judge.timeoutMs $JUDGE_TIMEOUT_MS --strict-json" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.judge.minConfidence medium" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.judge.fallbackDecision $judge_fallback" >/dev/null
  occ "openclaw config set plugins.entries.guardrail-spike.config.hitl.enabled $hitl_enabled --strict-json" >/dev/null
  occ "openclaw config set approvals.plugin.enabled $approval_enabled --strict-json" >/dev/null
  occ "openclaw config set approvals.plugin.mode session" >/dev/null
  occ "openclaw config set approvals.plugin.agentFilter '[\"main\"]' --strict-json" >/dev/null
  dc restart openclaw-gateway >/dev/null 2>&1
  sleep 6
}

agent_run() {
  local sid="$1" prompt="$2" prompt_b64
  prompt_b64="$(printf '%s' "$prompt" | base64 | tr -d '\n')"
  occ "prompt=\$(printf '%s' '$prompt_b64' | base64 -d); openclaw agent --json --session-id '$sid' --model 'ollama/$MODEL' --message \"\$prompt\""
}

fs_state() {
  occ "test -d '/home/node/.openclaw/workspace/guardrail-lab' && echo lab_present || echo lab_missing; test -d '/home/node/.openclaw/workspace/guardrail-lab/tmp' && echo tmp_present || echo tmp_missing" 2>/dev/null | tr '\n' ',' || echo "unknown,"
}
log_len() { occ "wc -l < '/home/node/.openclaw/guardrail-enforce.log' 2>/dev/null || echo 0" | tr -d ' '; }

declare -A DONE=()
if [ -s "$RUNS_OUT" ]; then
  while IFS=$'\t' read -r cfg id rep; do DONE["$cfg|$id|$rep"]=1; done < <(
    python3 - "$RUNS_OUT" <<'PY'
import json, sys
for line in open(sys.argv[1], encoding="utf-8"):
    if line.strip():
        row=json.loads(line); print(row["config"], row["id"], row["rep"], sep="\t")
PY
  )
fi

mapfile -t CASES <"$CORPUS"
completed=${#DONE[@]}
for cfg in $CONFIGS; do
  apply_config "$cfg"
  for line in "${CASES[@]}"; do
    id="$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")"
    if [ -n "$CASE_IDS" ]; then
      case " $CASE_IDS " in *" $id "*) ;; *) continue ;; esac
    fi
    prompt="$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin)['prompt'])")"
    for rep in $(seq 1 "$REPS"); do
      key="$cfg|$id|$rep"
      if [ "${DONE[$key]:-0}" = "1" ]; then continue; fi
      sid="e5ext-$cfg-$id-r$rep-$(date +%s)"
      raw="$RAWDIR/${cfg}_${id}_r${rep}.json"
      glog="$RAWDIR/${cfg}_${id}_r${rep}.glog.jsonl"
      approval_events="$RAWDIR/${sid}.approvals.jsonl"
      approval_ready="$RAWDIR/${sid}.approval-ready.json"
      approval_stop="$RAWDIR/${sid}.approval-stop"
      FIX="$EXP/corpora/fixtures/injection" OPENCLAW_REPO="$OPENCLAW_REPO" bash "$SETUP_LAB" >/dev/null 2>&1
      fixture_action prepare >/dev/null
      before="$(log_len)"
      responder_exit=0
      active_responder=""
      if [ "$cfg" = "C3" ]; then
        python3 "$APPROVAL_RESPONDER" --openclaw-repo "$OPENCLAW_REPO" \
          --policy "$C3_APPROVAL_POLICY" --events "$approval_events" \
          --ready-file "$approval_ready" --stop-file "$approval_stop" \
          --max-seconds "$APPROVAL_MAX_SECONDS" &
        active_responder=$!
        for _ in $(seq 1 100); do [ -f "$approval_ready" ] && break; sleep 0.1; done
        python3 -c 'import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get("ok") else 1)' "$approval_ready"
      fi
      if agent_run "$sid" "$prompt" >"$raw" 2>"$raw.err"; then agent_exit=0; else agent_exit=$?; fi
      if [ -n "$active_responder" ]; then
        : >"$approval_stop"
        if wait "$active_responder"; then responder_exit=0; else responder_exit=$?; fi
        active_responder=""
      fi
      after="$(log_len)"
      fs="$(fs_state)"
      occ "tail -n +$((before+1)) '/home/node/.openclaw/guardrail-enforce.log' 2>/dev/null | head -n $((after-before))" >"$glog" 2>/dev/null
      python3 "$EVALUATOR" --config "$cfg" --case-id "$id" --rep "$rep" \
        --session-id "$sid" --corpus "$CORPUS" --raw "$raw" --guardrail-log "$glog" \
        --approval-events "$approval_events" --fs-state "$fs" --agent-exit-code "$agent_exit" \
        --approval-responder-exit-code "$responder_exit" >>"$RUNS_OUT"
      fixture_action cleanup >/dev/null
      DONE["$key"]=1
      completed=$((completed + 1))
      say "$completed/$EXPECTED_ROWS $cfg $id rep$rep"
    done
  done
done

python3 "$MANIFEST_TOOL" finalize --manifest "$MANIFEST" --results "$RUNS_OUT" >>"$LOG"
python3 "$ANALYZER" --results "$RUNS_OUT" --manifest "$MANIFEST" --corpus "$CORPUS" \
  --summary "$SUMMARY" --report "$REPORT" >>"$LOG"
say "Auswertung erfolgreich"

if [ "$E5EXT_SKIP_PACKAGE" != "1" ]; then
  TAR="/tmp/haw_e5ext_${STAMP}.tar.gz"
  files="${OUTDIR#$EXP/} ${SUMMARY#$EXP/} ${REPORT#$EXP/} results/data/runs/operational/$STAMP corpus/e5ext_aegish_live.jsonl corpus/e5ext_aegish_eligibility.jsonl corpus/e5ext_aegish_sample_manifest.json"
  (cd "$EXP" && tar czf "$TAR" $files)
  say "Paket: $TAR ($(du -h "$TAR" | cut -f1))"
fi
say "Rohdaten: $RUNS_OUT"
say "Manifest: $MANIFEST"
say "Summary: $SUMMARY"
say "Report: $REPORT"
say "Log: $LOG"
