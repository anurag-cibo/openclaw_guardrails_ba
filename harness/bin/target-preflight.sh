#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_REPO_VALUE="${OPENCLAW_REPO:-/__openclaw_repo_not_set__}"
MODEL_VALUE="${MODEL:-qwen3:30b}"
JUDGE_MODEL_VALUE="${JUDGE_MODEL:-qwen3:30b}"
HARNESS_DATA_ROOT_VALUE="${HARNESS_DATA_ROOT:-$ROOT/corpora}"
FAILURES=0

ok() { printf '[OK]     %s\n' "$*"; }
fail() { printf '[FEHLER] %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

require_command() {
  if command -v "$1" >/dev/null 2>&1; then ok "$1 vorhanden"; else fail "$1 fehlt"; fi
}

printf 'Guardrail-Harness Live-Preflight (read-only)\n'
printf 'Harness:  %s\n' "$ROOT"
printf 'OpenClaw: %s\n\n' "$OPENCLAW_REPO_VALUE"

[ -n "${OPENCLAW_REPO:-}" ] && ok 'OPENCLAW_REPO explizit gesetzt' || fail 'OPENCLAW_REPO muss als absoluter Pfad gesetzt sein'

if [ ! -d "$HARNESS_DATA_ROOT_VALUE" ]; then
  fail "Korpus-Datenwurzel fehlt: $HARNESS_DATA_ROOT_VALUE"
elif [ ! -r "$HARNESS_DATA_ROOT_VALUE" ] || [ ! -x "$HARNESS_DATA_ROOT_VALUE" ]; then
  fail "Korpus-Datenwurzel ist nicht lesbar: $HARNESS_DATA_ROOT_VALUE"
else
  resolved_data_root="$(cd "$HARNESS_DATA_ROOT_VALUE" 2>/dev/null && pwd -P)"
  if [ "$resolved_data_root" = "/" ] || [ "$resolved_data_root" = "${HOME:-/__kein_home__}" ]; then
    fail "Korpus-Datenwurzel ist zu breit; eigenes Datenverzeichnis verwenden: $resolved_data_root"
  else
    ok "Korpus-Datenwurzel lesbar: $resolved_data_root"
  fi
fi

case "$(uname -s 2>/dev/null || true)" in Linux) ok 'Linux-Host' ;; *) fail 'Zielsystem ist nicht Linux' ;; esac
case "$(uname -m 2>/dev/null || true)" in x86_64|amd64) ok 'Architektur linux/amd64' ;; *) fail 'Architektur ist nicht x86_64/amd64' ;; esac
require_command bash
require_command docker
require_command nohup
require_command setsid
require_command tail
require_command flock

if command -v docker >/dev/null 2>&1; then
  if docker version >/dev/null 2>&1; then ok 'Docker-Daemon erreichbar'; else fail 'Docker-Daemon nicht erreichbar'; fi
  if docker compose version >/dev/null 2>&1; then ok 'Docker Compose v2 erreichbar'; else fail 'Docker Compose v2 fehlt'; fi
  harness_mounts="$(docker compose -f "$ROOT/runtime/compose.yaml" -f "$ROOT/runtime/live.compose.yaml" config 2>/dev/null || true)"
  if printf '%s\n' "$harness_mounts" | grep -A 8 'target: /harness-data' | grep -F 'read_only: true' >/dev/null 2>&1; then
    ok 'Externe Korpus-Datenwurzel wird read-only nach /harness-data gemountet'
  else
    fail 'Read-only-Mount der Korpus-Datenwurzel ist nicht nachweisbar'
  fi
fi

if [ -S /var/run/docker.sock ]; then
  ok 'Docker-Socket vorhanden'
  [ -r /var/run/docker.sock ] && ok 'Docker-Socket lesbar' || fail 'Docker-Socket nicht lesbar'
  [ -w /var/run/docker.sock ] && ok 'Docker-Socket schreibbar' || fail 'Docker-Socket nicht schreibbar'
else
  fail '/var/run/docker.sock fehlt oder ist kein Socket'
fi

for file in docker-compose.yml docker-compose.ollama.override.yml; do
  [ -f "$OPENCLAW_REPO_VALUE/$file" ] && ok "OpenClaw/$file vorhanden" || fail "OpenClaw/$file fehlt"
done

compose_ready=0
if [ -f "$OPENCLAW_REPO_VALUE/docker-compose.yml" ] && [ -f "$OPENCLAW_REPO_VALUE/docker-compose.ollama.override.yml" ] && command -v docker >/dev/null 2>&1; then
  compose=(docker compose -f "$OPENCLAW_REPO_VALUE/docker-compose.yml" -f "$OPENCLAW_REPO_VALUE/docker-compose.ollama.override.yml")
  services="$("${compose[@]}" config --services 2>/dev/null || true)"
  if [ -n "$services" ]; then
    ok 'OpenClaw-Compose-Konfiguration ist parsebar'
    compose_ready=1
  else
    fail 'OpenClaw-Compose-Konfiguration ist nicht parsebar'
  fi
  for service in openclaw-gateway ollama; do
    if printf '%s\n' "$services" | grep -Fx "$service" >/dev/null 2>&1; then
      ok "Compose-Service $service definiert"
      container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
      if [ -n "$container_id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$container_id" 2>/dev/null || true)" = 'true' ]; then
        ok "$service läuft"
      else
        fail "$service läuft nicht"
      fi
    else
      fail "Compose-Service $service fehlt"
    fi
  done
fi

expected_control="$(sed -n 's/^[[:space:]]*"builtImageId":[[:space:]]*"\(sha256:[a-f0-9]*\)".*/\1/p' "$ROOT/runtime/image-lock.json")"
imported_control="$(sed -n 's/^[[:space:]]*"targetImportedImageId":[[:space:]]*"\(sha256:[a-f0-9]*\)".*/\1/p' "$ROOT/runtime/image-lock.json")"
expected_host="$(sed -n 's/^[[:space:]]*"builtImageId":[[:space:]]*"\(sha256:[a-f0-9]*\)".*/\1/p' "$ROOT/runtime/host-runner-lock.json")"
imported_host="$(sed -n 's/^[[:space:]]*"targetImportedImageId":[[:space:]]*"\(sha256:[a-f0-9]*\)".*/\1/p' "$ROOT/runtime/host-runner-lock.json")"
expected_archive="$(sed -n 's/^[[:space:]]*"exportSha256":[[:space:]]*"\([a-f0-9]*\)".*/\1/p' "$ROOT/runtime/image-lock.json")"
archive_path="${HARNESS_IMAGE_ARCHIVE:-$ROOT/../guardrail-harness-images_20260810.tar.gz}"
archive_verified=0
archive_present=0

if [ -f "$archive_path" ]; then
  archive_present=1
  actual_archive="$(sha256sum "$archive_path" | awk '{print $1}')"
  if [ -n "$expected_archive" ] && [ "$actual_archive" = "$expected_archive" ]; then
    ok 'Imagearchiv stimmt per SHA-256 mit der Lockdatei überein'
    archive_verified=1
  else
    fail "Imagearchiv-SHA-256 weicht ab ($archive_path)"
  fi
else
  printf '[HINWEIS] Imagearchiv fehlt; Laufzeitidentitaet wird anhand der zuvor validierten HAW-Import-ID geprueft: %s\n' "$archive_path"
fi

if command -v docker >/dev/null 2>&1; then
  for specification in "guardrail-harness-runtime:dev|$expected_control|$imported_control|Control-Runtime" "guardrail-harness-host-runner:dev|$expected_host|$imported_host|Host-Runner"; do
    image_name="${specification%%|*}"
    rest="${specification#*|}"
    expected_id="${rest%%|*}"
    rest="${rest#*|}"
    imported_id="${rest%%|*}"
    label="${rest#*|}"
    actual_id="$(docker image inspect "$image_name" --format '{{.Id}}' 2>/dev/null || true)"
    if [ -z "$expected_id" ]; then
      fail "$label hat keine fixierte Image-ID"
    elif [ "$actual_id" = "$expected_id" ]; then
      ok "$label stimmt mit lokaler Build-ID der Lockdatei überein"
    elif [ "$actual_id" = "$imported_id" ]; then
      if [ "$archive_verified" = '1' ]; then
        ok "$label stimmt mit HAW-Import-ID und verifiziertem Exportarchiv überein"
      elif [ "$archive_present" = '0' ]; then
        ok "$label stimmt mit der in der Lockdatei zuvor validierten HAW-Import-ID überein"
      else
        fail "$label hat die HAW-Import-ID, aber das vorhandene Exportarchiv ist nicht verifiziert"
      fi
    elif [ -z "$actual_id" ]; then
      fail "$label-Image fehlt"
    else
      fail "$label-Image-ID weicht ab (erwartet $expected_id, gefunden $actual_id)"
    fi
  done
fi

if [ "$compose_ready" = '1' ]; then
  models="$("${compose[@]}" exec -T ollama ollama list 2>/dev/null || true)"
  for model in "$MODEL_VALUE" "$JUDGE_MODEL_VALUE"; do
    if printf '%s\n' "$models" | awk 'NR>1 {print $1}' | grep -Fx "$model" >/dev/null 2>&1; then
      ok "Ollama-Modell $model vorhanden"
    else
      fail "Ollama-Modell $model nicht nachgewiesen"
    fi
  done
fi

printf '\nErgebnis: %s Fehler\n' "$FAILURES"
if [ "$FAILURES" -ne 0 ]; then
  printf 'Live-/Approval-Läufe bleiben gesperrt.\n' >&2
  exit 1
fi
printf 'Zielhost-Preflight bestanden. Es wurde nichts verändert.\n'
