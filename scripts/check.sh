#!/usr/bin/env bash
#
# Reproduzierbarer Gesamtcheck des Guardrail-Plugins.
#
# Prueft in einem Durchlauf:
#   1. Node-Laufzeit          — mindestens Version 20
#   2. Testsuite              — npm test / node --test
#   3. JSON-Syntax            — alle getrackten JSON-Dateien des Plugins
#   4. Schema-Konsistenz      — openclaw.plugin.json gegen src/index.js
#   5. Fingerprint-Integritaet— src/ gegen harness/vendor/plugin-baseline/
#
# Es werden keine npm-Pakete installiert und keine der untersuchten
# Shell-Kommandos ausgefuehrt. Der Check veraendert nichts.
#
# Aufruf:   ./scripts/check.sh
# Exitcode: 0 = alles bestanden, 1 = mindestens eine Pruefung fehlgeschlagen

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

FAILURES=0
STEP=0

ok()   { printf '  [ok]     %s\n' "$*"; }
fail() { printf '  [FEHLER] %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
skip() { printf '  [uebersprungen] %s\n' "$*"; }
step() { STEP=$((STEP + 1)); printf '\n[%d/5] %s\n' "$STEP" "$*"; }

# --- 1. Node-Laufzeit -------------------------------------------------------
step "Node-Laufzeit"

if ! command -v node >/dev/null 2>&1; then
  fail "node ist nicht installiert"
  printf '\nAbbruch: ohne Node laesst sich nichts weiter pruefen.\n' >&2
  exit 1
fi

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"

if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
  ok "Node $NODE_VERSION (>= 20 erforderlich)"
else
  fail "Node $NODE_VERSION ist zu alt; erforderlich ist mindestens Version 20"
fi

# --- 2. Testsuite -----------------------------------------------------------
step "Testsuite"

TEST_LOG="$(mktemp)"
trap 'rm -f "$TEST_LOG"' EXIT

if node --test tests/*.test.js >"$TEST_LOG" 2>&1; then
  PASSED="$(grep -E '^# pass ' "$TEST_LOG" | tail -n 1 | awk '{print $3}')"
  ok "alle Tests bestanden (${PASSED:-?} Tests)"
else
  FAILED="$(grep -E '^# fail ' "$TEST_LOG" | tail -n 1 | awk '{print $3}')"
  fail "Testsuite fehlgeschlagen (${FAILED:-?} Fehler); Ausgabe folgt"
  sed 's/^/      /' "$TEST_LOG" | tail -n 40 >&2
fi

# --- 3. JSON-Syntax ---------------------------------------------------------
step "JSON-Syntax"

JSON_FILES="openclaw.plugin.json package.json"
JSON_OK=1

for file in $JSON_FILES; do
  if [ ! -f "$file" ]; then
    fail "$file fehlt"
    JSON_OK=0
    continue
  fi
  if ! node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'))" "$file" 2>/dev/null; then
    fail "$file ist kein gueltiges JSON"
    JSON_OK=0
  fi
done

[ "$JSON_OK" -eq 1 ] && ok "alle geprueften JSON-Dateien sind syntaktisch gueltig"

# --- 4. Schema-Konsistenz ---------------------------------------------------
step "Konsistenz der beiden Konfigurationsschemata"

# Das Konfigurationsschema steht doppelt im Repository: im Manifest
# openclaw.plugin.json und im Default-Export von src/index.js. Beide muessen
# uebereinstimmen, sonst kann eine Aenderung unbemerkt auseinanderlaufen.
SCHEMA_REPORT="$(node --input-type=module -e '
import fs from "node:fs";
const manifest = JSON.parse(fs.readFileSync("openclaw.plugin.json", "utf8"));
const plugin = (await import("./src/index.js")).default;

const a = manifest.configSchema?.properties ?? {};
const b = plugin.configSchema?.properties ?? {};
const problems = [];

const walk = (left, right, prefix) => {
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    const l = left[key];
    const r = right[key];
    if (l === undefined) { problems.push(`nur in src/index.js: ${path}`); continue; }
    if (r === undefined) { problems.push(`nur in openclaw.plugin.json: ${path}`); continue; }
    if (JSON.stringify(l.default) !== JSON.stringify(r.default)) {
      problems.push(`abweichender Default bei ${path}: ${JSON.stringify(l.default)} vs ${JSON.stringify(r.default)}`);
    }
    if (JSON.stringify(l.enum) !== JSON.stringify(r.enum)) {
      problems.push(`abweichendes enum bei ${path}`);
    }
    if (l.type !== r.type) {
      problems.push(`abweichender Typ bei ${path}: ${l.type} vs ${r.type}`);
    }
    if (l.properties && r.properties) walk(l.properties, r.properties, path);
  }
};

walk(a, b, "");
if (plugin.id !== manifest.id) problems.push(`abweichende Plugin-ID: ${plugin.id} vs ${manifest.id}`);
process.stdout.write(problems.join("\n"));
' 2>&1)"

if [ -z "$SCHEMA_REPORT" ]; then
  ok "openclaw.plugin.json und src/index.js beschreiben dasselbe Schema"
else
  fail "Die beiden Konfigurationsschemata weichen voneinander ab:"
  printf '%s\n' "$SCHEMA_REPORT" | sed 's/^/      /' >&2
fi

# --- 5. Fingerprint-Integritaet --------------------------------------------
step "Plugin-Kern gegen die Messreferenz des Harness"

BASELINE="harness/vendor/plugin-baseline"

if [ ! -d "$BASELINE" ]; then
  skip "$BASELINE nicht vorhanden (Harness nicht ausgecheckt)"
else
  DRIFT=0
  for relative in index.js openclaw.plugin.json package.json \
                  src/approval.js src/decisions.js src/index.js src/judge.js \
                  src/logger.js src/normalize-command.js src/policy.js; do
    if [ ! -f "$BASELINE/$relative" ]; then
      fail "in der Messreferenz fehlt: $relative"
      DRIFT=1
      continue
    fi
    # Zeilenendenormalisiert vergleichen, wie es der Harness ebenfalls tut.
    if ! diff -q <(tr -d '\r' < "$relative") <(tr -d '\r' < "$BASELINE/$relative") >/dev/null 2>&1; then
      fail "weicht von der Messreferenz ab: $relative"
      DRIFT=1
    fi
  done

  if [ "$DRIFT" -eq 0 ]; then
    ok "alle 10 gefingerprinteten Dateien stimmen mit der Messreferenz ueberein"
  else
    printf '      Hinweis: Eine Abweichung entwertet den Plugin-Fingerprint in den\n' >&2
    printf '      Manifesten bereits berichteter Messlaeufe. Siehe README, Abschnitt\n' >&2
    printf '      "Kopplung zwischen Plugin und Harness".\n' >&2
  fi
fi

# --- Ergebnis ---------------------------------------------------------------
printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf 'Ergebnis: alle Pruefungen bestanden.\n'
  exit 0
fi

printf 'Ergebnis: %d Pruefung(en) fehlgeschlagen.\n' "$FAILURES" >&2
exit 1
