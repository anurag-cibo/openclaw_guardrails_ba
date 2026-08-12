#!/usr/bin/env bash
set -euo pipefail

lock_root="${1:-}"
shift || true
if [ -z "$lock_root" ] || [ "$#" -eq 0 ]; then
  echo "[FEHLER] live-lock erwartet Lock-Ordner und Kommando." >&2
  exit 2
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "[FEHLER] flock fehlt; exklusiver Live-Lauf kann nicht garantiert werden." >&2
  exit 127
fi

mkdir -p "$lock_root"
lock_file="$lock_root/openclaw-live.lock"
owner_file="$lock_root/openclaw-live.owner"
exec 9>"$lock_file"

if ! flock -n 9; then
  echo "[FEHLER] Es läuft bereits ein Live-/Approval-Job gegen dieses OpenClaw-Ziel." >&2
  if [ -f "$owner_file" ]; then
    echo "Aktiver Besitzer:" >&2
    sed 's/^/  /' "$owner_file" >&2
  fi
  echo "Kein zweiter Lauf wurde gestartet." >&2
  exit 4
fi

{
  printf 'pid=%s\n' "$$"
  printf 'started_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'command='
  printf '%q ' "$@"
  printf '\n'
} > "$owner_file"

cleanup() {
  rm -f -- "$owner_file"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

set +e
"$@"
code=$?
set -e
exit "$code"
