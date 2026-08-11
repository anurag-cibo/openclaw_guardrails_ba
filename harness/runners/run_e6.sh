#!/usr/bin/env bash
# run_e6.sh -- unbeaufsichtigter Approval-Lifecycle-Test fuer das Guardrail.
#
# Hauptdesign: L-DR-02 unter C3, 3 Arme x E6_REPS. Der kontrollierte
# Tool-Call wird direkt ueber OpenClaws tools.invoke-RPC und den nur waehrend E6
# aktiven, fest auf das Fixture begrenzten guardrail_e6_exec-Treiber ausgeloest.
# E6 misst den technischen Approval-Lifecycle und nicht die Tool-Wahl eines LLM:
#   deny       -> Gateway-Aufloesung deny, tmp bleibt erhalten
#   allow-once -> Gateway-Aufloesung allow-once, tmp wird genau fuer diesen Call geloescht
#   timeout    -> keine Aufloesung, OpenClaw blockiert nach timeoutMs, tmp bleibt erhalten
# Zusaetzlich: E6_C2_REPS Kontrollen unter C2 ohne HITL (direkter Block).
#
# Das ist eine kontrollierte Guardrail-/Integrationsmessung, keine Nutzerstudie.
set -euo pipefail

OPENCLAW_REPO="${OPENCLAW_REPO:?OPENCLAW_REPO muss als absoluter Pfad gesetzt sein}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CORPUS="${CORPUS:-$HERE/../corpus/live_corpus.jsonl}"
OUTDIR="${OUTDIR:-$HERE/../results/data/live/current}"
RAWDIR="$OUTDIR/e6_raw"
RUNS_OUT="$OUTDIR/E6_approval_runs.jsonl"
GLOG="/home/node/.openclaw/guardrail-enforce.log"
WS="/home/node/.openclaw/workspace"

E6_CASE_ID="${E6_CASE_ID:-L-DR-02}"
E6_ARMS="${E6_ARMS:-deny allow-once timeout}"
E6_REPS="${E6_REPS:-5}"
E6_C2_REPS="${E6_C2_REPS:-5}"
JUDGE_MODEL="${JUDGE_MODEL:-qwen3:30b}"
JUDGE_BASE_URL="${JUDGE_BASE_URL:-http://ollama:11434}"
DRY_RUN="${DRY_RUN:-0}"
APPROVAL_MAX_SECONDS="${APPROVAL_MAX_SECONDS:-900}"
APPROVAL_RESPONDER="$HERE/approval_responder.py"
GATEWAY_ADMIN_CALL="$HERE/gateway_admin_call.py"
LIVE_EVALUATOR="$HERE/evaluate_live_run.py"

dc()  { docker compose -f "$OPENCLAW_REPO/docker-compose.yml" -f "$OPENCLAW_REPO/docker-compose.ollama.override.yml" "$@"; }
occ() { dc exec -T openclaw-gateway sh -lc "$1"; }
say() { echo "[e6] $*"; }
run() { if [ "$DRY_RUN" = "1" ]; then echo "  + $*"; else eval "$@"; fi; }

E6_HARNESS_ORIGINAL="false"
E6_HARNESS_CHANGED=0

enable_e6_harness_tool() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "  + temporarily enable guardrail-spike e6Harness"
    E6_HARNESS_CHANGED=1
    return
  fi

  E6_HARNESS_ORIGINAL=$(
    occ "openclaw config get plugins.entries.guardrail-spike.config.e6Harness.enabled" \
      2>/dev/null || printf 'false'
  )
  occ "openclaw config set plugins.entries.guardrail-spike.config.e6Harness.enabled true --strict-json"
  E6_HARNESS_CHANGED=1
}

restore_e6_harness_tool() {
  [ "$E6_HARNESS_CHANGED" = "1" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then
    echo "  + restore guardrail-spike e6Harness"
    return 0
  fi

  set +e
  occ "openclaw config set plugins.entries.guardrail-spike.config.e6Harness.enabled '$E6_HARNESS_ORIGINAL' --strict-json" >/dev/null 2>&1
  dc restart openclaw-gateway >/dev/null 2>&1
  set -e
}

trap restore_e6_harness_tool EXIT

if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$RAWDIR"
  : > "$RUNS_OUT"
fi

case_line=$(python3 - "$CORPUS" "$E6_CASE_ID" <<'PY'
import json,sys
path,cid=sys.argv[1:3]
for line in open(path, encoding="utf-8"):
    row=json.loads(line)
    if row.get("id")==cid:
        print(json.dumps(row, ensure_ascii=False))
        break
else:
    raise SystemExit(f"E6 case not found: {cid}")
PY
)
intended_command=$(printf '%s' "$case_line" | python3 -c "import sys,json;print(json.load(sys.stdin)['intended_command'])")

apply_config() {
  local cfg="$1"
  local judge_enabled judge_fallback hitl_enabled approval_enabled
  case "$cfg" in
    C2)
      judge_enabled="true"; judge_fallback="block"; hitl_enabled="false"; approval_enabled="false" ;;
    C3)
      judge_enabled="true"; judge_fallback="require_approval"; hitl_enabled="true"; approval_enabled="true" ;;
    *) say "ungueltige E6-Konfiguration: $cfg"; return 2 ;;
  esac

  run "occ \"openclaw config set plugins.entries.guardrail-spike.enabled true --strict-json\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.mode enforce\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.protectedTargets '[\\\"guardrail-lab\\\"]' --strict-json\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.approvalTargets '[\\\"guardrail-lab/tmp\\\"]' --strict-json\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.resolveSymlinks true --strict-json\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.escalateFallback block\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.judge.enabled $judge_enabled --strict-json\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.judge.model $JUDGE_MODEL\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.judge.baseUrl $JUDGE_BASE_URL\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.judge.timeoutMs 30000 --strict-json\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.judge.minConfidence medium\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.judge.fallbackDecision $judge_fallback\""
  run "occ \"openclaw config set plugins.entries.guardrail-spike.config.hitl.enabled $hitl_enabled --strict-json\""
  run "occ \"openclaw config set approvals.plugin.enabled $approval_enabled --strict-json\""
  run "occ \"openclaw config set approvals.plugin.mode session\""
  run "occ \"openclaw config set approvals.plugin.agentFilter '[\\\"main\\\"]' --strict-json\""
  run "dc restart openclaw-gateway >/dev/null 2>&1"
  run "sleep 6"
}

tool_invoke() {
  local sid="$1" command_value="$2" params
  params=$(python3 - "$sid" "$command_value" <<'PY'
import json,sys
sid,command=sys.argv[1:3]
print(json.dumps({
    "name": "guardrail_e6_exec",
    "args": {"command": command},
    "sessionKey": f"agent:main:explicit:{sid.lower()}",
    "agentId": "main",
    "confirm": True,
}, separators=(",", ":")))
PY
)
  python3 "$GATEWAY_ADMIN_CALL" \
    --openclaw-repo "$OPENCLAW_REPO" \
    --method tools.invoke \
    --params "$params" \
    --timeout-seconds 130
}

preflight_e6_tool() {
  local result
  if [ "$DRY_RUN" = "1" ]; then
    echo "  + preflight guardrail_e6_exec with pwd"
    return
  fi
  result=$(tool_invoke "gr-e6-preflight-$(date +%s)" "pwd")
  if ! printf '%s' "$result" | python3 -c \
    'import json,sys; value=json.load(sys.stdin); raise SystemExit(0 if value.get("ok") is True else 1)'
  then
    say "E6-Harness-Tool-Preflight fehlgeschlagen: $result"
    exit 4
  fi
}

fs_state() {
  occ "test -d '$WS/guardrail-lab' && echo lab_present || echo lab_missing; \
       test -d '$WS/guardrail-lab/tmp' && echo tmp_present || echo tmp_missing" 2>/dev/null | tr '\n' ',' || echo "unknown,"
}

log_len() { occ "wc -l < '$GLOG' 2>/dev/null || echo 0" | tr -d ' '; }

run_one() {
  local cfg="$1" arm="$2" rep="$3"
  local sid="gr-e6-$cfg-${arm//-/_}-r$rep-$(date +%s)"
  local raw="$RAWDIR/${cfg}_${arm}_r${rep}.json"
  local glog="$RAWDIR/${cfg}_${arm}_r${rep}.glog.jsonl"
  local approval_events="$RAWDIR/${sid}.approvals.jsonl"
  local approval_ready="$RAWDIR/${sid}.approval-ready.json"
  local approval_stop="$RAWDIR/${sid}.approval-stop"
  local responder_pid="" responder_exit=0 agent_exit=0 before after fs

  say "$cfg arm=$arm rep=$rep"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  + setup_lab.sh"
    [ "$cfg" = "C3" ] && echo "  + approval_responder.py --policy $arm"
    echo "  + tools.invoke guardrail_e6_exec $sid"
    return
  fi

  FIX="$HERE/../corpora/fixtures/injection" OPENCLAW_REPO="$OPENCLAW_REPO" \
    bash "$HERE/setup_lab.sh" >/dev/null 2>&1
  before=$(log_len)

  if [ "$cfg" = "C3" ]; then
    python3 "$APPROVAL_RESPONDER" \
      --openclaw-repo "$OPENCLAW_REPO" --policy "$arm" \
      --events "$approval_events" --ready-file "$approval_ready" \
      --stop-file "$approval_stop" \
      --require-request \
      --max-seconds "$APPROVAL_MAX_SECONDS" &
    responder_pid=$!
    for _ in $(seq 1 100); do
      [ -f "$approval_ready" ] && break
      sleep 0.1
    done
    if [ ! -f "$approval_ready" ] || ! python3 -c 'import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get("ok") else 1)' "$approval_ready"; then
      say "Approval-Responder-Preflight fehlgeschlagen"
      wait "$responder_pid" || true
      exit 3
    fi
  fi

  if tool_invoke "$sid" "$intended_command" > "$raw" 2>"$raw.err"; then
    agent_exit=0
  else
    agent_exit=$?
  fi
  if [ -n "$responder_pid" ]; then
    : > "$approval_stop"
    if wait "$responder_pid"; then responder_exit=0; else responder_exit=$?; fi
  fi

  after=$(log_len)
  fs=$(fs_state)
  occ "tail -n +$((before+1)) '$GLOG' 2>/dev/null | head -n $((after-before))" > "$glog" 2>/dev/null

  python3 "$LIVE_EVALUATOR" \
    --config "$cfg" --case-id "$E6_CASE_ID" --rep "$rep" --session-id "$sid" \
    --corpus "$CORPUS" --raw "$raw" --guardrail-log "$glog" \
    --approval-events "$approval_events" --fs-state "$fs" \
    --agent-exit-code "$agent_exit" --approval-responder-exit-code "$responder_exit" \
    --e6-arm "$arm" >> "$RUNS_OUT"
}

enable_e6_harness_tool
apply_config C3
preflight_e6_tool
for arm in $E6_ARMS; do
  case "$arm" in deny|allow-once|timeout) ;; *) say "ungueltiger E6-Arm: $arm"; exit 2 ;; esac
  for rep in $(seq 1 "$E6_REPS"); do run_one C3 "$arm" "$rep"; done
done

if [ "$E6_C2_REPS" -gt 0 ]; then
  apply_config C2
  for rep in $(seq 1 "$E6_C2_REPS"); do run_one C2 control_block "$rep"; done
fi

say "fertig. E6-Laeufe: $RUNS_OUT   Rohdaten: $RAWDIR/"
