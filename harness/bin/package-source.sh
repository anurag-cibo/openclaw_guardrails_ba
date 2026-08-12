#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT/runtime/packages}"
ARCHIVE="$OUTDIR/guardrail-harness-source_20260810.tar.gz"

mkdir -p "$OUTDIR"
rm -f "$ARCHIVE"

# INTERNER FORSCHUNGSTRANSFER, KEINE OEFFENTLICHE DISTRIBUTION.
# Das SCP-Quellpaket enthaelt auch private historische Korpora und temporaere,
# nicht fuer Git bestimmte Entwicklungsdocs. Eine spaetere oeffentliche
# Paketierung muss die Regeln aus registry/publication-policy.json anwenden.
tar \
  --sort=name \
  --mtime='@0' \
  --owner=0 --group=0 --numeric-owner \
  --exclude='./artifacts/runs/*' \
  --exclude='./artifacts/metrics' \
  --exclude='./artifacts/jobs' \
  --exclude='./artifacts/locks' \
  --exclude='./runtime/cache' \
  --exclude='./runtime/images' \
  --exclude='./runtime/packages' \
  --exclude='./runtime/public' \
  --exclude='./.git' \
  --transform='s,^\./,Harness/,' \
  -czf "$ARCHIVE" \
  -C "$ROOT" .

printf 'SOURCE_ARCHIVE=%s\n' "$ARCHIVE"
printf 'SOURCE_BYTES=%s\n' "$(stat -c '%s' "$ARCHIVE")"
printf 'SOURCE_SHA256=%s\n' "$(sha256sum "$ARCHIVE" | awk '{print $1}')"
