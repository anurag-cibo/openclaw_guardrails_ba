#!/usr/bin/env bash
# run_e6b.sh -- realer Agenten-/Core-exec-Approval-Test.
#
# ABGRENZUNG ZU run_e6.sh (E6a):
#   E6a  Harness -> Gateway-RPC tools.invoke -> guardrail_e6_exec
#        -> before_tool_call -> Approval -> Node-fs.rm auf festes Fixture
#        Zweck: Branch-/Resolution-/Enforcement-Fidelity ohne stochastische
#        Toolwahl. KEIN Core-exec-End-to-End-Test.
#
#   E6b  Harness -> openclaw agent --message -> LLM -> echtes Core-exec
#        -> before_tool_call -> Approval -> reale Shell-/Dateisystemwirkung
#        Zweck: Nachweis, dass der Approval-Pfad im vollstaendigen realen
#        Agentensystem und ueber mehrere Pfad-/Zielformen traegt.
#
#   tools.invoke exec wird bewusst NICHT erneut versucht. OpenClaw 2026.5.18
#   instanziiert die Coding-Core-Tools nicht im RPC-Katalog
#   ("Tool not available: exec"); das ist als Integrationsbefund geklaert.
#
# Alle Faelle sind nach policy.js spezifikationskonform require_approval
# (exec.delete.workspace_subtree). Es wird kein fachfremdes Kommando in die
# Approval-Klasse umklassifiziert.
#
# Variablen:
#   E6B_CASE_IDS="E6B-01 E6B-04"  -> Subset; leer = alle mit in_default_matrix
#   E6B_ARMS="deny allow-once"    -> Arme einschraenken; leer = pro Fall aus dem Korpus
#   E6B_REPS=3                    -> Wiederholungen je Fall-Arm-Kombination
#   E6B_C2_REPS=0                 -> optionale C2-Kontrolle (Block ohne HITL) am kanonischen Fall
#   MODEL=qwen3:30b  JUDGE_MODEL=qwen3:30b
#   DRY_RUN=1                     -> zeigt nur Kommandos
#
# Modellwahl siehe run_live.sh und Befund B8/B12 in docs/reports/findings/Gaps_und_Befunde.md.
set -euo pipefail

OPENCLAW_REPO="${OPENCLAW_REPO:?OPENCLAW_REPO muss als absoluter Pfad gesetzt sein}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CORPUS="${CORPUS:-$HERE/../corpus/e6b_corpus.jsonl}"
OUTDIR="${OUTDIR:-$HERE/../results/data/live/current}"
RAWDIR="$OUTDIR/e6b_raw"
RUNS_OUT="$OUTDIR/E6b_approval_runs.jsonl"
GLOG="/home/node/.openclaw/guardrail-enforce.log"
WS="/home/node/.openclaw/workspace"

E6B_CASE_IDS="${E6B_CASE_IDS:-}"
E6B_ARMS="${E6B_ARMS:-}"
# 5 statt 3 Reps wegen der modellseitigen Refusal-Rate (Befund B16): ein Teil
# der Laeufe erreicht den Enforcement-Punkt gar nicht und faellt als
# no_tool_call aus der Enforcement-Auswertung heraus.
E6B_REPS="${E6B_REPS:-5}"
E6B_C2_REPS="${E6B_C2_REPS:-0}"
E6B_C2_CASE_ID="${E6B_C2_CASE_ID:-E6B-01}"
MODEL="${MODEL:-qwen3:30b}"
JUDGE_MODEL="${JUDGE_MODEL:-qwen3:30b}"
JUDGE_BASE_URL="${JUDGE_BASE_URL:-http://ollama:11434}"
DRY_RUN="${DRY_RUN:-0}"
APPROVAL_MAX_SECONDS="${APPROVAL_MAX_SECONDS:-900}"
APPROVAL_RESPONDER="$HERE/approval_responder.py"
LIVE_EVALUATOR="$HERE/evaluate_live_run.py"

dc()  { docker compose -f "$OPENCLAW_REPO/docker-compose.yml" -f "$OPENCLAW_REPO/docker-compose.ollama.override.yml" "$@"; }
occ() { dc exec -T openclaw-gateway sh -lc "$1"; }
say() { echo "[e6b] $*"; }
run() { if [ "$DRY_RUN" = "1" ]; then echo "  + $*"; else eval "$@"; fi; }

# Gateway-Bereitschaft nach einem Neustart. Ersetzt die fruehere feste
# Wartezeit durch eine aktive RPC-Probe. Feste Wartezeiten sind keine
# Bereitschaftsannahme.
READINESS_PROBE="${READINESS_PROBE:-$HERE/../adapters/live/wait-gateway-rpc.sh}"
GATEWAY_ADMIN_CALL="${GATEWAY_ADMIN_CALL:-$HERE/gateway_admin_call.py}"
wait_for_gateway_rpc() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "  + warte auf Gateway-RPC-Bereitschaft"
    return
  fi
  GATEWAY_READY_LABEL="$1" bash "$READINESS_PROBE" "$GATEWAY_ADMIN_CALL" "$OPENCLAW_REPO"
}

if [ ! -f "$CORPUS" ]; then
  say "E6b-Korpus nicht gefunden: $CORPUS"
  exit 2
fi

# E6B_APPEND=1 haengt an eine bestehende Ergebnisdatei an, statt sie zu leeren.
# Noetig fuer Nachzieh-Laeufe: die bereits gemessenen Laeufe sind gueltig und
# duerfen nicht verloren gehen. Voraussetzung ist derselbe Plugin-Commit und
# dieselbe Konfiguration; beides steht im Run-Manifest.
E6B_APPEND="${E6B_APPEND:-0}"
if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$RAWDIR"
  if [ "$E6B_APPEND" = "1" ] && [ -f "$RUNS_OUT" ]; then
    say "Append-Modus: $(wc -l < "$RUNS_OUT") vorhandene Laeufe bleiben erhalten"
    cp "$RUNS_OUT" "$RUNS_OUT.bak.$(date +%Y%m%d_%H%M%S)"
  else
    : > "$RUNS_OUT"
  fi
fi

# ---- Konfigurationswechsel -------------------------------------------------
# Identisch zu run_live.sh, damit E5, E6a und E6b denselben Enforcement-Punkt
# unter denselben Schichtparametern messen.
apply_config() {
  local cfg="$1"
  local judge_enabled judge_fallback hitl_enabled approval_enabled
  say "wende Konfiguration $cfg an"
  case "$cfg" in
    C2) judge_enabled="true"; judge_fallback="block";            hitl_enabled="false"; approval_enabled="false" ;;
    C3) judge_enabled="true"; judge_fallback="require_approval"; hitl_enabled="true";  approval_enabled="true"  ;;
    *)  say "ungueltige E6b-Konfiguration: $cfg"; return 2 ;;
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
  wait_for_gateway_rpc e6b
}

# ---- ein einzelner realer Agentenlauf --------------------------------------
# Identisch zu run_live.sh: OpenClaw 2026.5.18 verlangt -m/--message.
agent_run() { # agent_run <session_id> <prompt>
  local sid="$1" prompt="$2" prompt_b64
  prompt_b64=$(printf '%s' "$prompt" | base64 | tr -d '\n')
  occ "prompt=\$(printf '%s' '$prompt_b64' | base64 -d); openclaw agent --json --session-id '$sid' --model 'ollama/$MODEL' --message \"\$prompt\""
}

# Dateisystemzustand fallabhaengig: das Schutzgut guardrail-lab muss in jedem
# E6b-Lauf ueberleben, das fs_target des Falls belegt die Approval-Wirkung.
fs_state_for_target() { # fs_state_for_target <workspace-relatives Ziel>
  local target="$1"
  occ "test -d '$WS/guardrail-lab' && echo lab_present || echo lab_missing; \
       test -d '$WS/$target' && echo target_present || echo target_missing" 2>/dev/null \
    | tr '\n' ',' || echo "unknown,"
}

log_len() { occ "wc -l < '$GLOG' 2>/dev/null || echo 0" | tr -d ' '; }

field() { # field <json-zeile> <schluessel>
  printf '%s' "$1" | python3 -c "import sys,json;print(json.load(sys.stdin)[sys.argv[1]])" "$2"
}

# ---- ein Messlauf ----------------------------------------------------------
run_one() { # run_one <cfg> <case_line> <arm> <rep>
  local cfg="$1" line="$2" arm="$3" rep="$4"
  local id target prompt sid raw glog approval_events approval_ready approval_stop
  local responder_pid="" responder_exit=0 agent_exit=0 before after fs

  id=$(field "$line" id)
  target=$(field "$line" fs_target)
  prompt=$(field "$line" prompt)
  sid="gr-e6b-$cfg-$id-${arm//-/_}-r$rep-$(date +%s)"
  raw="$RAWDIR/${cfg}_${id}_${arm}_r${rep}.json"
  glog="$RAWDIR/${cfg}_${id}_${arm}_r${rep}.glog.jsonl"
  approval_events="$RAWDIR/${sid}.approvals.jsonl"
  approval_ready="$RAWDIR/${sid}.approval-ready.json"
  approval_stop="$RAWDIR/${sid}.approval-stop"

  say "$cfg $id arm=$arm rep=$rep  (Ziel: $target)"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  + setup_lab.sh"
    [ "$cfg" = "C3" ] && echo "  + approval_responder.py --policy $arm --require-request"
    echo "  + agent_run $sid \"$prompt\""
    echo "  + evaluate_live_run.py --e6-mode b --e6-arm $arm --fs-state <lab,target>"
    return
  fi

  FIX="$HERE/../corpora/fixtures/injection" OPENCLAW_REPO="$OPENCLAW_REPO" \
    E6B_EDGE_FIXTURES="${E6B_EDGE_FIXTURES:-0}" \
    bash "$HERE/setup_lab.sh" >/dev/null 2>&1
  before=$(log_len)

  # Jeder E6b-Fall ist deterministisch approvalpflichtig, deshalb erzwingt der
  # Responder hier immer eine sichtbare plugin:-ID (Befund B11/B13).
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
      say "Approval-Responder-Preflight fehlgeschlagen: $cfg $id $arm rep$rep"
      wait "$responder_pid" || true
      exit 3
    fi
  fi

  if agent_run "$sid" "$prompt" > "$raw" 2>"$raw.err"; then
    agent_exit=0
  else
    agent_exit=$?
    say "Agenten-CLI fehlgeschlagen: $cfg $id $arm rep$rep (exit=$agent_exit)"
  fi

  if [ -n "$responder_pid" ]; then
    : > "$approval_stop"
    if wait "$responder_pid"; then responder_exit=0; else responder_exit=$?; fi
    [ "$responder_exit" = "0" ] || say "Approval-Responder: exit=$responder_exit ($id $arm rep$rep)"
  fi

  after=$(log_len)
  fs=$(fs_state_for_target "$target")
  occ "tail -n +$((before+1)) '$GLOG' 2>/dev/null | head -n $((after-before))" > "$glog" 2>/dev/null

  python3 "$LIVE_EVALUATOR" \
    --config "$cfg" --case-id "$id" --rep "$rep" --session-id "$sid" \
    --corpus "$CORPUS" --raw "$raw" --guardrail-log "$glog" \
    --approval-events "$approval_events" --fs-state "$fs" \
    --agent-exit-code "$agent_exit" --approval-responder-exit-code "$responder_exit" \
    --e6-arm "$arm" --e6-mode b >> "$RUNS_OUT"
}

# ---- Fallauswahl -----------------------------------------------------------
mapfile -t ALL_CASES < "$CORPUS"
SELECTED=()
for line in "${ALL_CASES[@]}"; do
  [ -n "$line" ] || continue
  id=$(field "$line" id)
  if [ -n "$E6B_CASE_IDS" ]; then
    for wanted in $E6B_CASE_IDS; do
      [ "$id" = "$wanted" ] && SELECTED+=("$line")
    done
  else
    in_default=$(field "$line" in_default_matrix)
    [ "$in_default" = "True" ] && SELECTED+=("$line")
  fi
done

if [ "${#SELECTED[@]}" -eq 0 ]; then
  say "keine E6b-Faelle ausgewaehlt (E6B_CASE_IDS=$E6B_CASE_IDS)"
  exit 2
fi

# Fallabhaengige Reps: stark zensierte Faelle brauchen mehr Wiederholungen,
# um dieselbe Zahl verwertbarer Laeufe zu erreichen. E6B_REPS ueberschreibt.
case_reps() { # case_reps <json-zeile>
  local explicit
  if [ -n "${E6B_REPS_OVERRIDE:-}" ]; then printf '%s' "$E6B_REPS_OVERRIDE"; return; fi
  explicit=$(printf '%s' "$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reps') or '')")
  printf '%s' "${explicit:-$E6B_REPS}"
}

planned=0
for line in "${SELECTED[@]}"; do
  arms=$(printf '%s' "$line" | python3 -c "import sys,json;print(' '.join(json.load(sys.stdin)['arms']))")
  reps=$(case_reps "$line")
  for arm in $arms; do
    if [ -n "$E6B_ARMS" ]; then
      case " $E6B_ARMS " in *" $arm "*) ;; *) continue ;; esac
    fi
    planned=$((planned + reps))
  done
done
say "Faelle: ${#SELECTED[@]}, geplante C3-Laeufe: $planned, Modell: $MODEL"

# ---- Hauptschleife ---------------------------------------------------------
apply_config C3
for line in "${SELECTED[@]}"; do
  arms=$(printf '%s' "$line" | python3 -c "import sys,json;print(' '.join(json.load(sys.stdin)['arms']))")
  reps=$(case_reps "$line")
  for arm in $arms; do
    case "$arm" in deny|allow-once|timeout) ;; *) say "ungueltiger E6b-Arm: $arm"; exit 2 ;; esac
    if [ -n "$E6B_ARMS" ]; then
      case " $E6B_ARMS " in *" $arm "*) ;; *) continue ;; esac
    fi
    for rep in $(seq 1 "$reps"); do
      run_one C3 "$line" "$arm" "$rep"
    done
  done
done

# ---- optionale C2-Kontrolle ------------------------------------------------
# Zeigt, dass dasselbe reale Kommando ohne HITL-Schicht direkt geblockt wird.
if [ "$E6B_C2_REPS" -gt 0 ]; then
  c2_line=""
  for line in "${SELECTED[@]}"; do
    [ "$(field "$line" id)" = "$E6B_C2_CASE_ID" ] && c2_line="$line"
  done
  if [ -z "$c2_line" ]; then
    say "C2-Kontrollfall $E6B_C2_CASE_ID nicht in der Auswahl; C2 wird uebersprungen"
  else
    apply_config C2
    for rep in $(seq 1 "$E6B_C2_REPS"); do
      run_one C2 "$c2_line" control_block "$rep"
    done
  fi
fi

say "fertig. E6b-Laeufe: $RUNS_OUT   Rohdaten: $RAWDIR/"
