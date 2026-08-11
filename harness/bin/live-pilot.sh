#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

profile_path=""
expect_profile_path=0
for argument in "$@"; do
  if [ "$expect_profile_path" = "1" ]; then
    profile_path="$argument"
    expect_profile_path=0
  elif [ "$argument" = "--profile" ]; then
    expect_profile_path=1
  fi
done
if [ "$expect_profile_path" = "1" ]; then
  echo "[FEHLER] --profile erwartet einen JSON-Pfad." >&2
  exit 2
fi

if [ -n "$profile_path" ]; then
  mapfile -t profile_models < <(
    docker compose -f "$ROOT/runtime/compose.yaml" run --rm control profile models "$profile_path"
  )
  if [ "${#profile_models[@]}" -ne 3 ]; then
    echo "[FEHLER] Profilmodellauflösung lieferte ${#profile_models[@]} statt 3 Werten." >&2
    exit 2
  fi
  export MODEL="${profile_models[0]}"
  export JUDGE_MODEL="${profile_models[1]}"
  export JUDGE_BASE_URL="${profile_models[2]}"
  printf 'Profilmodelle: Agent=%s  Judge=%s  Endpoint=%s\n' "$MODEL" "$JUDGE_MODEL" "$JUDGE_BASE_URL"
fi

bash "$ROOT/bin/target-preflight.sh"
export HARNESS_DOCKER_GID="${HARNESS_DOCKER_GID:-$(stat -c '%g' /var/run/docker.sock)}"

exec docker compose -f "$ROOT/runtime/compose.yaml" -f "$ROOT/runtime/live.compose.yaml" \
  run --rm host-runner "$@"
