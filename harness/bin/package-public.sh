#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT/runtime/packages}"
STAGED="$ROOT/runtime/public/guardrail-harness-public"
ARCHIVE_NAME="${2:-guardrail-harness-public_20260811.tar.gz}"
case "$ARCHIVE_NAME" in
  *[!A-Za-z0-9._-]*|*.tar.gz.tar.gz|''|.*) echo "[FEHLER] Ungueltiger Archivname: $ARCHIVE_NAME" >&2; exit 2 ;;
esac
case "$ARCHIVE_NAME" in
  *.tar.gz) ;;
  *) echo "[FEHLER] Archivname muss auf .tar.gz enden: $ARCHIVE_NAME" >&2; exit 2 ;;
esac
ARCHIVE="$OUTDIR/$ARCHIVE_NAME"

node "$ROOT/src/tools/build-public-distribution.mjs" --output "$STAGED"
mkdir -p "$OUTDIR"
rm -f "$ARCHIVE"

tar \
  --sort=name \
  --mtime='@0' \
  --owner=0 --group=0 --numeric-owner \
  --transform='s,^guardrail-harness-public,Guardrail-Harness,' \
  -czf "$ARCHIVE" \
  -C "$(dirname "$STAGED")" "$(basename "$STAGED")"

printf 'PUBLIC_ARCHIVE=%s\n' "$ARCHIVE"
printf 'PUBLIC_BYTES=%s\n' "$(stat -c '%s' "$ARCHIVE")"
printf 'PUBLIC_SHA256=%s\n' "$(sha256sum "$ARCHIVE" | awk '{print $1}')"
