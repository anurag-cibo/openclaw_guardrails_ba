#!/usr/bin/env bash
set -euo pipefail

validate_job_id() {
  case "$1" in
    ''|*[!A-Za-z0-9_.-]*) echo "[FEHLER] Ungültige Job-ID: $1" >&2; exit 2 ;;
  esac
}

job_state() {
  local directory="$1" pid code
  if [ -f "$directory/exit-code" ]; then
    code="$(tr -d '[:space:]' < "$directory/exit-code")"
    if [ "$code" = '0' ]; then printf 'completed'; else printf 'failed(exit=%s)' "$code"; fi
    return
  fi
  pid="$(tr -d '[:space:]' < "$directory/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then printf 'running'; else printf 'interrupted-or-unknown'; fi
}

command="${1:-}"
case "$command" in
  launch)
    jobs_root="${2:-}"
    shift 2 || true
    if [ -z "$jobs_root" ] || [ "$#" -eq 0 ]; then
      echo "[FEHLER] job-control launch erwartet Job-Ordner und Kommando." >&2
      exit 2
    fi
    mkdir -p "$jobs_root"
    job_id="$(date -u '+%Y%m%dT%H%M%SZ')_${$}_${RANDOM}"
    job_directory="$jobs_root/$job_id"
    mkdir "$job_directory"
    printf '%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$job_directory/started-at"
    printf '%q ' "$@" > "$job_directory/command.txt"
    printf '\n' >> "$job_directory/command.txt"

    nohup setsid bash -c '
      job_directory="$1"
      shift
      "$@"
      code=$?
      printf "%s\n" "$code" > "$job_directory/exit-code.tmp"
      mv "$job_directory/exit-code.tmp" "$job_directory/exit-code"
      date -u "+%Y-%m-%dT%H:%M:%SZ" > "$job_directory/finished-at"
      exit "$code"
    ' harness-job "$job_directory" "$@" \
      > "$job_directory/console.log" 2>&1 < /dev/null &
    job_pid=$!
    printf '%s\n' "$job_pid" > "$job_directory/pid"
    printf 'Job:    %s\n' "$job_id"
    printf 'PID:    %s\n' "$job_pid"
    printf 'Status: %s\n' "$(job_state "$job_directory")"
    printf 'Log:    %s\n' "$job_directory/console.log"
    ;;
  status)
    jobs_root="${2:-}"
    job_id="${3:-}"
    validate_job_id "$job_id"
    job_directory="$jobs_root/$job_id"
    [ -d "$job_directory" ] || { echo "[FEHLER] Job nicht gefunden: $job_id" >&2; exit 2; }
    printf 'Job:       %s\n' "$job_id"
    printf 'PID:       %s\n' "$(tr -d '[:space:]' < "$job_directory/pid")"
    printf 'Status:    %s\n' "$(job_state "$job_directory")"
    printf 'Gestartet: %s\n' "$(cat "$job_directory/started-at")"
    [ ! -f "$job_directory/finished-at" ] || printf 'Beendet:   %s\n' "$(cat "$job_directory/finished-at")"
    printf 'Log:       %s\n' "$job_directory/console.log"
    ;;
  list)
    jobs_root="${2:-}"
    mkdir -p "$jobs_root"
    shopt -s nullglob
    directories=("$jobs_root"/*)
    if [ "${#directories[@]}" -eq 0 ]; then echo 'Noch keine Hintergrundjobs.'; exit 0; fi
    for job_directory in "${directories[@]}"; do
      [ -d "$job_directory" ] || continue
      printf '%-35s %s\n' "$(basename "$job_directory")" "$(job_state "$job_directory")"
    done
    ;;
  log)
    jobs_root="${2:-}"
    job_id="${3:-}"
    follow="${4:-}"
    validate_job_id "$job_id"
    log_file="$jobs_root/$job_id/console.log"
    [ -f "$log_file" ] || { echo "[FEHLER] Job-Log nicht gefunden: $job_id" >&2; exit 2; }
    if [ "$follow" = '--follow' ]; then exec tail -n 50 -f "$log_file"; fi
    exec tail -n 50 "$log_file"
    ;;
  *) echo 'Usage: job-control.sh <launch|status|list|log> ...' >&2; exit 2 ;;
esac
