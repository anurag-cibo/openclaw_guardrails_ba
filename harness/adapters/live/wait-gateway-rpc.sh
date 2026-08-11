#!/usr/bin/env bash
# Wait until an authenticated Gateway RPC succeeds. This checks the same RPC
# transport used by the approval harness instead of relying on container state.
set -euo pipefail

CALLER="${1:-}"
OPENCLAW_REPO="${2:-}"
ATTEMPTS="${GATEWAY_READY_ATTEMPTS:-30}"
INTERVAL_SECONDS="${GATEWAY_READY_INTERVAL_SECONDS:-2}"
TIMEOUT_SECONDS="${GATEWAY_READY_TIMEOUT_SECONDS:-5}"
ERROR_FILE="${GATEWAY_READY_ERROR_FILE:-}"
LABEL="${GATEWAY_READY_LABEL:-e6}"

[ -f "$CALLER" ] || { echo "[$LABEL] Gateway-Aufrufer fehlt: $CALLER" >&2; exit 2; }
[ -n "$OPENCLAW_REPO" ] || { echo "[$LABEL] OPENCLAW_REPO fehlt" >&2; exit 2; }
case "$ATTEMPTS" in ''|*[!0-9]*|0) echo "[$LABEL] ungueltige Gateway-Probezahl: $ATTEMPTS" >&2; exit 2 ;; esac

temporary_error=""
if [ -z "$ERROR_FILE" ]; then
  temporary_error="$(mktemp)"
  ERROR_FILE="$temporary_error"
fi
cleanup() { [ -z "$temporary_error" ] || rm -f "$temporary_error"; }
trap cleanup EXIT

for attempt in $(seq 1 "$ATTEMPTS"); do
  if python3 "$CALLER" \
    --openclaw-repo "$OPENCLAW_REPO" \
    --method plugin.approval.list \
    --params '{}' \
    --timeout-seconds "$TIMEOUT_SECONDS" \
    >/dev/null 2>"$ERROR_FILE"
  then
    : > "$ERROR_FILE"
    echo "[$LABEL] Gateway-RPC bereit (Probe $attempt/$ATTEMPTS)"
    exit 0
  fi
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    echo "[$LABEL] Gateway-RPC noch nicht bereit (Probe $attempt/$ATTEMPTS); neuer Versuch in ${INTERVAL_SECONDS}s"
    sleep "$INTERVAL_SECONDS"
  fi
done

echo "[$LABEL] Gateway-RPC wurde nach $ATTEMPTS Proben nicht bereit" >&2
[ ! -s "$ERROR_FILE" ] || cat "$ERROR_FILE" >&2
exit 1
