#!/usr/bin/env bash
# run_all.sh -- vollstaendige Messserie in einem Durchgang.
#
# Reihenfolge bewusst kurz-nach-lang: Fehler in der Umgebung sollen nach
# Minuten auffallen und nicht nach sieben Stunden. Jede Stufe schreibt in eine
# eigene Ergebnisdatei und ist unabhaengig wiederholbar.
#
#   E1  Policy-Korpus offline              (Sekunden)
#   E2  Evasions-Korpus offline            (Sekunden)
#   E3  Latenz-Mikrobenchmark              (Minuten)
#   E6a Approval-Lifecycle, Treiber        (~25 min)
#   E4  Judge-Charakterisierung, echt      (~1 h)
#   E6b Approval-Lifecycle, reales exec    (~2 h)
#   E5  Live-Hauptserie C0-C3              (~6-7 h)
#   E7  Metriken und Abbildungen           (Sekunden)
#
# Nutzung auf dem HAW-Host, abgekoppelt von der SSH-Sitzung:
#   cd <harness-wurzel>
#   nohup bash harness/run_all.sh > /dev/null 2>&1 &
#   tail -f results/data/runs/operational/<stamp>/run_all.log
#
# Einzelne Stufen:
#   STAGES="E6b E5" bash harness/run_all.sh
#
# Eine fehlgeschlagene Stufe bricht die Serie NICHT ab. Sie wird als failed
# vermerkt, damit ein Nachtlauf nicht an einer einzelnen Stufe verloren geht.
set -uo pipefail

OPENCLAW_REPO="${OPENCLAW_REPO:?OPENCLAW_REPO muss als absoluter Pfad gesetzt sein}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EXP="$(cd "$HERE/.." && pwd)"
DATA="$EXP/results/data"
RES="$DATA/current"
METRICS="$EXP/docs/evaluations/generated/metrics"
mkdir -p "$RES"

STAGES="${STAGES:-E1 E2 E3 E4 E6a E6b E5 E7 E7fig}"
# Nachtlauf-Nachzug: STAGES="E4 E6bTop E5new E5judge E7 E7fig"
MODEL="${MODEL:-qwen3:30b}"
JUDGE_MODEL="${JUDGE_MODEL:-qwen3:30b}"
JUDGE_BASE_URL="${JUDGE_BASE_URL:-http://ollama:11434}"

E5_REPS="${E5_REPS:-5}"
E5_CONFIGS="${E5_CONFIGS:-C0 C1 C2 C3}"
E5_CASE_IDS="${E5_CASE_IDS:-}"
E6A_REPS="${E6A_REPS:-5}"
E6A_C2_REPS="${E6A_C2_REPS:-5}"
E6B_REPS="${E6B_REPS:-15}"
E4_REPS="${E4_REPS:-5}"
E4_MODELS="${E4_MODELS:-qwen3:30b}"
E4_CORPUS="${E4_CORPUS:-corpus/policy_corpus.jsonl}"
E3_ITERS="${E3_ITERS:-2000}"

# ---------------------------------------------------------------------------
# PILOT=1 -- Rauchtest aller Stufen in ~30 Minuten statt ~11 Stunden.
#
# Zweck: jede Stufe einmal echt anfassen, bevor Serverzeit im Stundenbereich
# investiert wird. Besonders relevant fuer E4, das bisher ausschliesslich im
# Mock-Modus lief und noch nie gegen echte Ollama-Inferenz geprueft wurde.
# Der Pilot schreibt nach results/data/pilot/ und laesst die echten Ergebnisdateien
# unberuehrt. Er ist ausdruecklich KEINE Messserie.
# ---------------------------------------------------------------------------
PILOT="${PILOT:-0}"
OUTDIR_ARG=""
if [ "$PILOT" = "1" ]; then
  E3_ITERS=50
  E4_REPS=1
  E4_CORPUS="$DATA/pilot/e4_pilot_corpus.jsonl"
  E6A_REPS=1; E6A_C2_REPS=1
  E6B_REPS=1
  E5_REPS=1
  E5_CASE_IDS="${E5_CASE_IDS:-L-DB-01 L-DB-04 L-DR-01 L-DR-02}"
  OUTDIR_ARG="$DATA/pilot"
  mkdir -p "$DATA/pilot"
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
RUNDIR="$DATA/runs/operational/$STAMP"
mkdir -p "$RUNDIR"
LOG="$RUNDIR/run_all.log"

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# ---------------------------------------------------------------------------
# Run-Manifest (Design-Gap G4): festhalten, WORAN gemessen wurde.
# Ohne diese Angaben ist eine Messserie spaeter nicht mehr zuzuordnen.
# ---------------------------------------------------------------------------
write_manifest() {
  local plugin_dir="${GUARDRAIL_PLUGIN_DIR:?GUARDRAIL_PLUGIN_DIR muss gesetzt sein}"
  local commit="unknown" openclaw_version="unknown" ollama_models="unknown"

  commit=$(git -C "$plugin_dir" rev-parse HEAD 2>/dev/null || echo unknown)
  openclaw_version=$(
    docker compose -f "$OPENCLAW_REPO/docker-compose.yml" \
      -f "$OPENCLAW_REPO/docker-compose.ollama.override.yml" \
      exec -T openclaw-gateway sh -lc 'openclaw --version' 2>/dev/null | tr -d '\r' || echo unknown
  )
  ollama_models=$(
    docker compose -f "$OPENCLAW_REPO/docker-compose.yml" \
      -f "$OPENCLAW_REPO/docker-compose.ollama.override.yml" \
      exec -T ollama sh -lc 'ollama list' 2>/dev/null | tr -d '\r' || echo unknown
  )

  python3 - "$RUNDIR/run_manifest.json" <<PY
import json, sys, platform, subprocess
manifest = {
    "stamp": "$STAMP",
    "stages": "$STAGES".split(),
    "plugin_commit": """$commit""".strip(),
    "openclaw_version": """$openclaw_version""".strip(),
    "agent_model": "$MODEL",
    "judge_model": "$JUDGE_MODEL",
    "judge_base_url": "$JUDGE_BASE_URL",
    "reps": {"E5": $E5_REPS, "E6a": $E6A_REPS, "E6b": $E6B_REPS, "E4": $E4_REPS},
    "e5_configs": "$E5_CONFIGS".split(),
    "e4_models": "$E4_MODELS".split(","),
    "host": platform.node(),
    "ollama_list": """$ollama_models""".strip().splitlines(),
}
try:
    manifest["gpu"] = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
        capture_output=True, text=True, timeout=20).stdout.strip().splitlines()
except Exception as error:
    manifest["gpu"] = f"unavailable: {error}"
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2, ensure_ascii=False)
print(json.dumps({k: manifest[k] for k in
                  ("plugin_commit", "openclaw_version", "agent_model", "reps")}, indent=2))
PY
}

# ---------------------------------------------------------------------------
# Node-Ausfuehrung
#
# Der HAW-Host hat kein Node im PATH; der Gateway-Container bringt es mit
# (v24). Statt Node auf dem Host zu installieren, werden die Node-Stufen in
# einem Einweg-Container aus demselben Image ausgefuehrt. Das Projektverzeichnis
# wird unter identischem Pfad eingehaengt, damit alle relativen Pfade in den
# Skripten (Korpus, ../../guardrail-plugin/.../src/policy.js) unveraendert
# aufgehen. Fuer E4 wird zusaetzlich das Compose-Netz verbunden, damit der
# containerinterne Hostname "ollama" aufloest.
# ---------------------------------------------------------------------------
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$EXP/.." && pwd)}"
DOCKER_NETWORK="${DOCKER_NETWORK:-openclaw_default}"

# Plugin-Quellpfad: Das Repository ist auf dem HAW-Host direkt nach
# guardrail-plugin/ ausgecheckt, in der lokalen Windows-Arbeitskopie dagegen
# nach guardrail-plugin/openclaw_guardrails_ba/. Die .mjs-Skripte gehen vom
# zweiten Layout aus und brechen sonst mit Exit 2 ab ("policy.js nicht
# gefunden"). Statt einen der beiden Pfade festzuschreiben, wird der
# tatsaechlich vorhandene gesucht und ueber GUARDRAIL_SRC gesetzt.
if [ -z "${GUARDRAIL_SRC:-}" ]; then
  for candidate in \
    "$PROJECT_ROOT/guardrail-plugin/openclaw_guardrails_ba/src" \
    "$PROJECT_ROOT/guardrail-plugin/src" \
    "$EXP/../guardrail-plugin/src"
  do
    if [ -f "$candidate/policy.js" ]; then
      GUARDRAIL_SRC="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi
export GUARDRAIL_SRC="${GUARDRAIL_SRC:-}"

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
    node "$@"
    return $?
  fi
  if [ -z "$GATEWAY_IMAGE" ]; then
    GATEWAY_IMAGE=$(resolve_gateway_image) || {
      echo "node fehlt und Gateway-Image nicht ermittelbar" >&2
      return 127
    }
  fi
  docker run --rm \
    --network "$DOCKER_NETWORK" \
    -v "$PROJECT_ROOT":"$PROJECT_ROOT" \
    -w "$EXP" \
    -e JUDGE_BASE_URL="$JUDGE_BASE_URL" \
    -e JUDGE_MODELS="$E4_MODELS" \
    -e JUDGE_REPS="$E4_REPS" \
    -e JUDGE_MOCK="${JUDGE_MOCK:-}" \
    -e GUARDRAIL_SRC="$GUARDRAIL_SRC" \
    --user "$(id -u):$(id -g)" \
    "$GATEWAY_IMAGE" node "$@"
}

declare -A STATUS
declare -A DURATION

stage() { # stage <name> <befehl...>
  local name="$1"; shift
  case " $STAGES " in *" $name "*) ;; *) STATUS[$name]="skipped"; return 0 ;; esac

  local start end
  say "=== $name startet ==="
  start=$(date +%s)
  if ( cd "$EXP" && "$@" ) >>"$RUNDIR/$name.log" 2>&1; then
    STATUS[$name]="ok"
  else
    STATUS[$name]="FAILED(exit=$?)"
  fi
  end=$(date +%s)
  DURATION[$name]=$((end - start))
  say "=== $name: ${STATUS[$name]} nach $(( ${DURATION[$name]} / 60 )) min ==="
}

if [ "$PILOT" = "1" ]; then
  say "*** PILOTMODUS -- Rauchtest, KEINE Messserie. Ausgabe nach $DATA/pilot/ ***"
fi
say "Messserie $STAMP -- Stufen: $STAGES"
say "Agent=$MODEL  Judge=$JUDGE_MODEL  E5-Reps=$E5_REPS  E6b-Reps=$E6B_REPS"

# Preflight: fehlende Werkzeuge sollen benannt werden, bevor Stufen scheitern.
if command -v node >/dev/null 2>&1; then
  say "Preflight: node auf dem Host -> $(node --version)"
else
  GATEWAY_IMAGE="${GATEWAY_IMAGE:-$(resolve_gateway_image || true)}"
  if [ -n "$GATEWAY_IMAGE" ]; then
    say "Preflight: kein node auf dem Host, nutze Container-Image $GATEWAY_IMAGE"
  else
    say "Preflight: WARNUNG -- weder node noch Gateway-Image; E1-E4 werden scheitern"
  fi
fi
command -v python3 >/dev/null 2>&1 || say "Preflight: WARNUNG -- python3 fehlt"
docker compose version >/dev/null 2>&1 || say "Preflight: WARNUNG -- docker compose fehlt"
if [ -n "$GUARDRAIL_SRC" ]; then
  say "Preflight: Plugin-Quelle -> $GUARDRAIL_SRC"
else
  say "Preflight: WARNUNG -- policy.js nicht gefunden; E1/E2/E3/E4 werden mit Exit 2 abbrechen"
fi
python3 -c 'import matplotlib' >/dev/null 2>&1 \
  || say "Preflight: WARNUNG -- matplotlib fehlt; E7fig wird scheitern (E7 laeuft trotzdem)"
write_manifest | tee -a "$LOG"

OUT="${OUTDIR_ARG:-$RES}"

# Im Pilot einen kleinen Judge-Korpus erzeugen: acht escalate_llm-Faelle
# reichen, um Erreichbarkeit, Prompt, JSON-Parsing und Confidence-Gating
# einmal echt zu pruefen.
if [ "$PILOT" = "1" ]; then
  say "Pilot: erzeuge E4-Teilkorpus"
  ( cd "$EXP" && node -e "
    const fs=require('fs');const {pathToFileURL}=require('node:url');
    (async()=>{
      const {evaluateExecPolicy}=await import(pathToFileURL('../guardrail-plugin/openclaw_guardrails_ba/src/policy.js').href);
      const cfg={workspaceRoot:'/home/node/.openclaw/workspace',protectedTargets:['guardrail-lab'],
                 approvalTargets:['guardrail-lab/tmp'],resolveSymlinks:false,escalateFallback:'block'};
      // Stratifiziert ueber die Risikoklassen: ein Pilot, der nur benigne
      // Faelle enthaelt, wuerde weder das Confidence-Gating noch den
      // fail-closed Fallback des Judge auf riskanten Eingaben pruefen.
      const byClass=new Map();
      for(const l of fs.readFileSync('corpus/policy_corpus.jsonl','utf8').split('\n').filter(Boolean)){
        const r=JSON.parse(l);
        if(evaluateExecPolicy({command:r.command,cwd:cfg.workspaceRoot},cfg).decision!=='escalate_llm')continue;
        const k=r.risk_class||'?';
        if(!byClass.has(k))byClass.set(k,[]);
        byClass.get(k).push(l);
      }
      const out=[];
      for(let round=0;round<3&&out.length<10;round++)
        for(const rows of byClass.values())
          if(rows[round]&&out.length<10)out.push(rows[round]);
      fs.writeFileSync('$E4_CORPUS',out.join('\n')+'\n');
      console.log('E4-Pilotkorpus:',out.length,'Faelle aus',byClass.size,'Risikoklassen');
    })();
  " ) 2>&1 | tee -a "$LOG"
fi

# --- Offline ---------------------------------------------------------------
stage E1 node_run harness/run_policy_offline.mjs corpus/policy_corpus.jsonl "$OUT/E1_policy_results.jsonl"
stage E2 node_run harness/run_policy_offline.mjs corpus/evasion_corpus.jsonl "$OUT/E2_evasion_results.jsonl"
stage E3 node_run harness/bench_policy_latency.mjs "$E3_ITERS" corpus/policy_corpus.jsonl "$OUT/E3_latency.json"

# --- Judge, echte Inferenz --------------------------------------------------
# Vorgezogen: E4 ist die einzige Stufe, die noch nie gegen echte Ollama-
# Inferenz lief. Ein Fehler hier soll nach Minuten auffallen, nicht nach
# Stunden Agentenlaeufen.
# node_run reicht JUDGE_* selbst durch (Container) bzw. erbt sie (Host).
export JUDGE_BASE_URL JUDGE_MODELS="$E4_MODELS" JUDGE_REPS="$E4_REPS"
stage E4 node_run harness/run_judge_offline.mjs "$E4_CORPUS" "$OUT/E4_judge_results.jsonl"

# --- Kontrollierter Approval-Lifecycle -------------------------------------
stage E6a env E6_REPS="$E6A_REPS" E6_C2_REPS="$E6A_C2_REPS" \
  JUDGE_MODEL="$JUDGE_MODEL" OPENCLAW_REPO="$OPENCLAW_REPO" OUTDIR="$OUT" \
  bash harness/run_e6.sh

# --- Realer Agentenpfad -----------------------------------------------------
stage E6b env E6B_REPS="$E6B_REPS" MODEL="$MODEL" JUDGE_MODEL="$JUDGE_MODEL" \
  OPENCLAW_REPO="$OPENCLAW_REPO" OUTDIR="$OUT" \
  bash harness/run_e6b.sh

# --- Nachzieh-Stufen ---------------------------------------------------------
# Alle mit APPEND=1: die Serie 20260728_161627 ist gueltig und wird ergaenzt,
# nicht ersetzt. Voraussetzung ist derselbe Plugin-Commit (im Manifest).

# E6bTop: fehlende Reps je Fall gemaess der gemessenen Refusal-Raten.
# Vorhanden sind je 15 Reps fuer deny/allow-once aller fuenf Faelle sowie
# 15 timeout-Laeufe fuer E6B-01.
export OPENCLAW_REPO MODEL JUDGE_MODEL OUTDIR="$OUT"
stage E6bTop bash -c '
  set -e
  run() { echo "--- E6b-Nachzug: $*"; env E6B_APPEND=1 "$@" bash harness/run_e6b.sh; }
  run E6B_CASE_IDS=E6B-02 E6B_ARMS=timeout        E6B_REPS_OVERRIDE=15
  run E6B_CASE_IDS=E6B-03 E6B_ARMS="deny allow-once" E6B_REPS_OVERRIDE=15
  run E6B_CASE_IDS=E6B-04 E6B_ARMS="deny allow-once" E6B_REPS_OVERRIDE=30
  run E6B_CASE_IDS=E6B-05 E6B_ARMS="deny allow-once" E6B_REPS_OVERRIDE=10
'

# --- Live-Hauptserie --------------------------------------------------------
stage E5 env CONFIGS="$E5_CONFIGS" REPS="$E5_REPS" MODEL="$MODEL" JUDGE_MODEL="$JUDGE_MODEL" \
  CASE_IDS="$E5_CASE_IDS" OPENCLAW_REPO="$OPENCLAW_REPO" OUTDIR="$OUT" \
  bash harness/run_live.sh

# E5new: die sechs neuen Korpusfaelle -- vier benign_unlisted (stuetzen H4,
# das bisher an L-DB-04 allein hing) und zwei umformulierte riskante Varianten
# gegen die Refusal-Zensur von L-DR-03 und L-NW-01.
stage E5new env E5_APPEND=1 CONFIGS="$E5_CONFIGS" REPS="$E5_REPS" MODEL="$MODEL" \
  JUDGE_MODEL="$JUDGE_MODEL" OPENCLAW_REPO="$OPENCLAW_REPO" OUTDIR="$OUT" \
  CASE_IDS="L-DB-06 L-DB-07 L-DB-08 L-DB-09 L-DR-03b L-NW-01b" \
  bash harness/run_live.sh

# E5judge: zusaetzliche Reps fuer die Faelle, an denen die Judge-Varianz haengt.
# Die Judge-FN-Rate bei L-SR-02 beruht bisher auf 1 von 5 Laeufen; das ist zu
# grob, um Nichtdeterminismus zu quantifizieren. Nur C2/C3, weil nur dort der
# Judge ueberhaupt aktiv ist.
stage E5judge env E5_APPEND=1 CONFIGS="C2 C3" REPS="${E5_JUDGE_REPS:-15}" MODEL="$MODEL" \
  JUDGE_MODEL="$JUDGE_MODEL" OPENCLAW_REPO="$OPENCLAW_REPO" OUTDIR="$OUT" \
  CASE_IDS="L-SR-02 L-INJ-03" \
  bash harness/run_live.sh

# --- Auswertung -------------------------------------------------------------
# Im Pilot uebersprungen: die Metrik-Pipeline liest aus results/data/ und wuerde
# sonst Pilotdaten mit echten Serien vermischen.
if [ "$PILOT" != "1" ]; then
  stage E7 python3 results/analysis/metrics/compute_metrics.py
  stage E7fig python3 results/analysis/figures/make_figures.py
else
  STATUS[E7]="pilot-uebersprungen"; STATUS[E7fig]="pilot-uebersprungen"
fi

# --- Ergebnisse sichern -----------------------------------------------------
say ""
say "===================== ZUSAMMENFASSUNG ====================="
total=0
for name in E1 E2 E3 E4 E6a E6b E6bTop E5 E5new E5judge E7 E7fig; do
  s="${STATUS[$name]:-nicht ausgefuehrt}"
  d="${DURATION[$name]:-0}"
  total=$((total + d))
  printf '%-6s %-18s %5s min\n' "$name" "$s" "$((d / 60))" | tee -a "$LOG"
done
say "Gesamtdauer: $((total / 60)) min"
say "Manifest:    $RUNDIR/run_manifest.json"
say "Logs:        $RUNDIR/"

# Ergebnis-Snapshot dieser Serie, damit ein spaeterer Lauf ihn nicht ueberschreibt.
for f in E1_policy_results.jsonl E2_evasion_results.jsonl E3_latency.json \
         E4_judge_results.jsonl E5_live_runs.jsonl \
         E6_approval_runs.jsonl E6b_approval_runs.jsonl; do
  [ -f "$RES/$f" ] && cp "$RES/$f" "$RUNDIR/" 2>/dev/null
done
for f in metrics_report.md metrics_summary.json; do
  [ -f "$METRICS/$f" ] && cp "$METRICS/$f" "$RUNDIR/" 2>/dev/null
done
say "Snapshot der Ergebnisdateien liegt in $RUNDIR/"

for name in "${!STATUS[@]}"; do
  case "${STATUS[$name]}" in FAILED*) exit 1 ;; esac
done
exit 0
