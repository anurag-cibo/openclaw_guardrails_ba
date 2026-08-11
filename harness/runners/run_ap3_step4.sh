#!/usr/bin/env bash
# run_ap3_step4.sh -- AP3 Schritt 4 auf dem HAW-Host starten.
# Stand 2026-08-04, angepasst an die ueberarbeiteten Skripte
# (NOTIZEN_Schritt4_Methodenreview_20260804.md).
#
# WARUM DIESES SKRIPT?
# Der Befehl in Abschnitt 6 der Notizen ist fuer eine Umgebung mit lokalem node
# und lokalem Ollama geschrieben. Auf dem HAW-Host trifft beides nicht zu:
#   - kein node im PATH          -> Lauf muss im Gateway-Container erfolgen
#   - Ollama nur im Compose-Netz -> Hostname "ollama", nicht 127.0.0.1
#   - Plugin liegt unter guardrail-plugin/src statt .../openclaw_guardrails_ba/src
# Dieses Skript uebernimmt exakt die node_run-Bruecke aus run_all.sh und reicht
# JUDGE_ARMS / JUDGE_TIMEOUT_MS durch, die run_all.sh nicht kennt.
#
# NUTZUNG
#   cd <harness-wurzel>
#   PILOT=1 bash harness/run_ap3_step4.sh                      # ~110 Aufrufe, ~25 min
#   STEP=main setsid nohup bash harness/run_ap3_step4.sh > /dev/null 2>&1 &
#   tail -f results/data/runs/operational/<stamp>/AP3S4.log
#
# WICHTIG: setsid, nicht nur nohup. Ohne eigene Session haengt der Lauf am
# Terminal; bricht die SSH-Sitzung weg, leitet der Docker-Client SIGHUP in den
# Container und der Lauf stirbt mit exit=129 (passiert am 4.8. bei 131/550).
#
# STEP=main   nur Schritt 4        (550 Aufrufe)
# STEP=evasion nur die Luecke aus Abschnitt 4 der Notizen (90 Aufrufe)
# STEP=both   beides hintereinander (empfohlen, wenn die GPU ohnehin laeuft)
#
# Die Auswertung (analyze_judge_extension.py) laeuft NICHT hier, sondern lokal:
# ihr --e4-Default zeigt auf results/data/runs/nachtlauf_20260729/e4_real/.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXP="$(cd "$HERE/.." && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$EXP/.." && pwd)}"
DATA="$EXP/results/data"
RES="$DATA/lab/e4"
EVAL="$EXP/docs/evaluations/e4"
STAMP="$(date +%Y%m%d_%H%M%S)"
RUNDIR="$DATA/runs/operational/$STAMP"
mkdir -p "$RUNDIR"
LOG="$RUNDIR/AP3S4.log"

OPENCLAW_REPO="${OPENCLAW_REPO:?OPENCLAW_REPO muss als absoluter Pfad gesetzt sein}"
DOCKER_NETWORK="${DOCKER_NETWORK:-openclaw_default}"
JUDGE_BASE_URL="${JUDGE_BASE_URL:-http://ollama:11434}"
JUDGE_MODELS="${JUDGE_MODELS:-qwen3:30b}"
JUDGE_ARMS="${JUDGE_ARMS:-anchor_allow,neutral_escalate}"
JUDGE_TIMEOUT_MS="${JUDGE_TIMEOUT_MS:-90000}"
PILOT="${PILOT:-0}"
STEP="${STEP:-main}"

CORPUS="$EXP/corpus/e1_extension_ruleevasion.jsonl"
EVCORPUS="$EXP/corpus/evasion_corpus.jsonl"
RUNNER="$EXP/harness/run_judge_extension.mjs"
RUNNER_OFF="$EXP/harness/run_judge_offline.mjs"

if [ "$PILOT" = "1" ]; then
  JUDGE_REPS="${JUDGE_REPS:-1}"
  mkdir -p "$DATA/pilot"
  OUT="$DATA/pilot/E4ext_judge_ruleevasion_PILOT.jsonl"
  OUT_EV="$DATA/pilot/E4_judge_evasion_PILOT.jsonl"
  SUMMARY_OUT="$DATA/pilot/E4ext_judge_ruleevasion_PILOT_summary.json"
else
  JUDGE_REPS="${JUDGE_REPS:-5}"
  # OUT ueberschreibbar, damit ein Zusatzlauf (z. B. mit Ablationsarm) die
  # eingefrorene Messdatei vom 4.8. nicht ueberschreibt.
  OUT="${OUT:-$RES/E4ext_judge_ruleevasion.jsonl}"
  OUT_EV="${OUT_EV:-$RES/E4_judge_evasion.jsonl}"
  SUMMARY_OUT="${SUMMARY_OUT:-$EVAL/E4ext_judge_ruleevasion_summary.json}"
fi
export SUMMARY_OUT

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# --- Preflight ------------------------------------------------------------
say "AP3 Schritt 4 -- Start (STEP=$STEP, PILOT=$PILOT, reps=$JUDGE_REPS, arme=$JUDGE_ARMS)"
fail=0
need=("$CORPUS" "$RUNNER")
case "$STEP" in evasion|both) need+=("$EVCORPUS" "$RUNNER_OFF");; esac
for f in "${need[@]}"; do
  if [ -f "$f" ]; then say "gefunden: ${f#$EXP/}"
  else say "FEHLT: ${f#$EXP/}  -- von der Windows-Arbeitskopie hierher kopieren"; fail=1; fi
done
# Die benigne Kontrollgruppe (Fix 1) zieht diese beiden Korpora nach.
for f in "$EXP/corpus/policy_corpus.jsonl" "$EXP/corpus/evasion_corpus.jsonl"; do
  [ -f "$f" ] || { say "FEHLT (benigne Kontrollgruppe): ${f#$EXP/}"; fail=1; }
done

if [ -z "${GUARDRAIL_SRC:-}" ]; then
  for candidate in \
    "$PROJECT_ROOT/guardrail-plugin/openclaw_guardrails_ba/src" \
    "$PROJECT_ROOT/guardrail-plugin/src" \
    "$EXP/../guardrail-plugin/src"
  do
    [ -f "$candidate/policy.js" ] && { GUARDRAIL_SRC="$(cd "$candidate" && pwd)"; break; }
  done
fi
if [ -n "${GUARDRAIL_SRC:-}" ] && [ -f "$GUARDRAIL_SRC/judge.js" ]; then
  say "Plugin-Quelle: $GUARDRAIL_SRC"
else
  say "FEHLT: policy.js/judge.js nicht gefunden -- GUARDRAIL_SRC manuell setzen"; fail=1
fi
export GUARDRAIL_SRC="${GUARDRAIL_SRC:-}"

if [ "$PILOT" != "1" ]; then
  for f in "$OUT" "$OUT_EV"; do
    [ -f "$f" ] && say "WARNUNG: ${f#$EXP/} existiert und wird ueberschrieben."
  done
fi

[ "$fail" = "1" ] && { say "Preflight fehlgeschlagen -- Abbruch."; exit 2; }

# --- Node-Ausfuehrung (identisch zu run_all.sh) ---------------------------
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
    JUDGE_BASE_URL="$JUDGE_BASE_URL" JUDGE_MODELS="$JUDGE_MODELS" \
    JUDGE_REPS="$JUDGE_REPS" JUDGE_ARMS="$JUDGE_ARMS" \
    JUDGE_TIMEOUT_MS="$JUDGE_TIMEOUT_MS" GUARDRAIL_SRC="$GUARDRAIL_SRC" \
    node "$@"
    return $?
  fi
  if [ -z "$GATEWAY_IMAGE" ]; then
    GATEWAY_IMAGE=$(resolve_gateway_image) || {
      say "node fehlt und Gateway-Image nicht ermittelbar"; return 127; }
    say "Gateway-Image: $GATEWAY_IMAGE (Netz $DOCKER_NETWORK)"
  fi
  # --sig-proxy=false: sonst leitet der Docker-Client Signale an den Container
  # weiter. Am 4.8. hat ein SSH-Abbruch (SIGHUP) den Lauf bei 131/550 getoetet
  # -- nohup schuetzt das Skript, nicht den Container (exit=129).
  docker run --rm --sig-proxy=false \
    --network "$DOCKER_NETWORK" \
    -v "$PROJECT_ROOT":"$PROJECT_ROOT" \
    -w "$EXP" \
    -e JUDGE_BASE_URL="$JUDGE_BASE_URL" \
    -e JUDGE_MODELS="$JUDGE_MODELS" \
    -e JUDGE_REPS="$JUDGE_REPS" \
    -e JUDGE_ARMS="$JUDGE_ARMS" \
    -e JUDGE_TIMEOUT_MS="$JUDGE_TIMEOUT_MS" \
    -e GUARDRAIL_SRC="$GUARDRAIL_SRC" \
    --user "$(id -u):$(id -g)" \
    "$GATEWAY_IMAGE" node "$@"
}

# Erreichbarkeit aus DERSELBEN Netzwerksicht pruefen, aus der der Lauf kommt.
# Genau daran ist E4 im ersten Nachtlauf gescheitert (E4.log brach nach der
# ersten Zeile ab).
say "Preflight: pruefe $JUDGE_BASE_URL ..."
cat > "$RUNDIR/_ping.mjs" <<'EOF'
const url = process.env.JUDGE_BASE_URL + "/api/tags";
try {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  const names = (j.models || []).map((m) => m.name);
  console.log("Ollama erreichbar. Modelle:", names.join(", ") || "(keine)");
  for (const want of (process.env.JUDGE_MODELS || "").split(",").map(s => s.trim()).filter(Boolean)) {
    if (!names.includes(want)) {
      console.error(`WARNUNG: Modell ${want} nicht geladen -> ollama pull ${want}`);
      process.exit(4);
    }
  }
} catch (e) {
  console.error("Ollama NICHT erreichbar:", String(e));
  process.exit(5);
}
EOF
if node_run "$RUNDIR/_ping.mjs" >>"$LOG" 2>&1; then
  say "Preflight ok."
else
  say "Preflight FEHLGESCHLAGEN -- siehe Log. Abbruch."; exit 3
fi

# --- Laeufe ---------------------------------------------------------------
run_stage() { # run_stage <name> <befehl...>
  local name="$1"; shift
  say "=== $name startet ==="
  local start end
  start=$(date +%s)
  if node_run "$@" >>"$LOG" 2>&1; then st="ok"; else st="FAILED(exit=$?)"; fi
  end=$(date +%s)
  say "=== $name: $st nach $(( (end - start) / 60 )) min ==="
  [ "$st" = "ok" ]
}

case "$STEP" in
  main|both)
    run_stage "Schritt4 (55 Faelle x $JUDGE_REPS Reps x Arme)" \
      harness/run_judge_extension.mjs "$CORPUS" "$OUT"
    ;;
esac
case "$STEP" in
  evasion|both)
    # Luecke aus Abschnitt 4 der Notizen: 18 riskante escalate-Faelle aus
    # evasion_corpus.jsonl, die E4 real nie bewertet hat.
    run_stage "Evasions-Luecke (18 Faelle x $JUDGE_REPS Reps)" \
      harness/run_judge_offline.mjs "$EVCORPUS" "$OUT_EV"
    ;;
esac

# --- Paket fuer den Transfer nach Windows --------------------------------
TAR=/tmp/haw_ap3s4.tar.gz
files=""
for f in "$OUT" "$SUMMARY_OUT" "$OUT_EV"; do
  [ -f "$f" ] && files="$files ${f#$EXP/}"
done
( cd "$EXP" && tar czf "$TAR" $files "results/data/runs/operational/$STAMP" 2>/dev/null )
say "Paket: $TAR ($(du -h "$TAR" 2>/dev/null | cut -f1))"
say "Protokoll: $LOG"
[ "$PILOT" = "1" ] && say "PILOT -- Zahlen NICHT verwertbar, nur Pipeline-Nachweis."
say "Wichtig im Log pruefen: Fallback-Rate nahe 0. Sonst ist 'gefangen' fail-closed."
