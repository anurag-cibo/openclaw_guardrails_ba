#!/usr/bin/env bash
set -u

section() {
  printf '\n== %s ==\n' "$1"
}

run_optional() {
  if "$@" 2>&1; then
    return 0
  fi
  printf '[nicht verfügbar]\n'
  return 0
}

section "Zeit"
run_optional date -u '+UTC=%Y-%m-%dT%H:%M:%SZ'

section "System"
run_optional uname -a
run_optional sh -c 'printf "arch="; uname -m'
run_optional id

section "Laufzeiten auf dem Host"
for name in bash docker node python3 python; do
  if command -v "$name" >/dev/null 2>&1; then
    printf '%s=%s\n' "$name" "$(command -v "$name")"
  else
    printf '%s=MISSING\n' "$name"
  fi
done

section "Docker"
run_optional docker version
run_optional docker compose version
if [ -S /var/run/docker.sock ]; then
  run_optional stat -c 'socket=%n mode=%a owner=%U group=%G gid=%g' /var/run/docker.sock
else
  printf 'socket=/var/run/docker.sock MISSING_OR_NOT_SOCKET\n'
fi

section "Docker-Dienste und Netze"
run_optional docker compose ls --format json
run_optional docker network ls --format '{{.Name}}'

section "OpenClaw-Projekt"
OPENCLAW_REPO_VALUE="${OPENCLAW_REPO:-}"
printf 'path=%s\n' "${OPENCLAW_REPO_VALUE:-NOT_SET}"
if [ -n "$OPENCLAW_REPO_VALUE" ] && [ -f "$OPENCLAW_REPO_VALUE/docker-compose.yml" ] && [ -f "$OPENCLAW_REPO_VALUE/docker-compose.ollama.override.yml" ]; then
  printf 'compose_files=present\n'
  run_optional docker compose \
    -f "$OPENCLAW_REPO_VALUE/docker-compose.yml" \
    -f "$OPENCLAW_REPO_VALUE/docker-compose.ollama.override.yml" \
    config --services
else
  printf 'compose_files=missing\n'
fi

section "Speicher"
run_optional df -h .

section "Vorhandenes Gateway-Image"
run_optional docker image inspect ghcr.io/openclaw/openclaw:latest \
  --format 'id={{.Id}} architecture={{.Architecture}} os={{.Os}}'
