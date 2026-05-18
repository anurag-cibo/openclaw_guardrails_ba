#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_REPO="${OPENCLAW_REPO:-"$PROJECT_ROOT/../repo/openclaw"}"

COMPOSE_FILE_1="$OPENCLAW_REPO/docker-compose.yml"
COMPOSE_FILE_2="$OPENCLAW_REPO/docker-compose.ollama.override.yml"
ENV_FILE="$OPENCLAW_REPO/.env"

SERVICE="openclaw-gateway"
TARGET_CONTAINER="/home/node/.openclaw/local-plugins/guardrail-spike"

info() {
  echo "[INFO] $*"
}

warn() {
  echo "[WARN] $*" >&2
}

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

compose() {
  docker compose -f "$COMPOSE_FILE_1" -f "$COMPOSE_FILE_2" "$@"
}

read_openclaw_config_dir() {
  local value=""

  if [ -f "$ENV_FILE" ]; then
    value="$(grep -E '^OPENCLAW_CONFIG_DIR=' "$ENV_FILE" | tail -n 1 | cut -d '=' -f 2- || true)"
  fi

  if [ -z "$value" ]; then
    value="$HOME/.openclaw"
  fi

  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"

  printf '%s\n' "$value"
}

check_required_files() {
  [ -f "$COMPOSE_FILE_1" ] || fail "docker-compose.yml not found: $COMPOSE_FILE_1"
  [ -f "$COMPOSE_FILE_2" ] || fail "docker-compose.ollama.override.yml not found: $COMPOSE_FILE_2"

  for required in package.json openclaw.plugin.json index.js src/index.js; do
    [ -f "$PROJECT_ROOT/$required" ] || fail "Missing required file: $PROJECT_ROOT/$required"
  done
}

wait_for_gateway() {
  local max_attempts="${1:-90}"
  local attempt=1

  info "Waiting for gateway health on http://127.0.0.1:18789 ..."

  while [ "$attempt" -le "$max_attempts" ]; do
    if curl -fsS http://127.0.0.1:18789/healthz >/dev/null 2>&1; then
      info "Gateway healthz is reachable."

      if curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1; then
        info "Gateway readyz is reachable."
      else
        warn "Gateway healthz is reachable, but readyz is not ready yet."
      fi

      return 0
    fi

    sleep 1
    attempt=$((attempt + 1))
  done

  warn "Gateway did not become healthy within ${max_attempts}s."
  return 1
}

hard_restart_gateway() {
  warn "Normal gateway restart/start failed."
  warn "Falling back to hard gateway cleanup."
  warn "This only targets containers whose name matches: openclaw-openclaw-gateway"
  warn "It may ask for your sudo password to kill stuck gateway container PIDs."
  warn "The script checks PID > 1 and does not touch Ollama."

  info "Disabling restart policy for existing gateway containers..."
  for c in $(docker ps -aq --filter "name=openclaw-openclaw-gateway"); do
    docker update --restart=no "$c" >/dev/null 2>&1 || true
  done

  info "Killing running gateway container PIDs if necessary..."
  for c in $(docker ps -q --filter "name=openclaw-openclaw-gateway"); do
    pid="$(docker inspect -f '{{.State.Pid}}' "$c" 2>/dev/null || echo 0)"
    name="$(docker inspect -f '{{.Name}}' "$c" 2>/dev/null || echo unknown)"

    if [ "$pid" -gt 1 ]; then
      warn "Killing $name via host PID=$pid"
      sudo kill -9 "$pid" || true
    else
      warn "Skipping $name because PID=$pid"
    fi
  done

  sleep 2

  info "Removing old gateway containers..."
  docker rm -f $(docker ps -aq --filter "name=openclaw-openclaw-gateway") >/dev/null 2>&1 || true

  info "Starting gateway service via docker compose up -d..."
  compose up -d "$SERVICE"
}

ensure_gateway_running() {
  info "Ensuring Ollama is running..."
  compose up -d ollama

  info "Ensuring gateway service is running..."
  if compose up -d "$SERVICE"; then
    info "Gateway service start/up command completed."
  else
    hard_restart_gateway
  fi

  wait_for_gateway 90 || {
    warn "Gateway healthcheck failed. Recent gateway logs:"
    compose logs --tail 120 "$SERVICE" || true
    exit 2
  }
}

create_source_tar() {
  cd "$PROJECT_ROOT"

  tar \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='*.log' \
    --exclude='*.jsonl' \
    --exclude='tmp' \
    -cf - \
    package.json \
    openclaw.plugin.json \
    index.js \
    src \
    README.md \
    docs \
    tests \
    scripts
}

deploy_via_host_mount_if_possible() {
  local openclaw_config_dir="$1"
  local target_host="$openclaw_config_dir/local-plugins/guardrail-spike"

  if [ ! -d "$openclaw_config_dir" ]; then
    warn "Host OpenClaw config dir does not exist or is not visible: $openclaw_config_dir"
    return 1
  fi

  if [ ! -w "$openclaw_config_dir" ]; then
    warn "Host OpenClaw config dir is not writable by current user: $openclaw_config_dir"
    return 1
  fi

  info "Deploying via writable host mount."
  info "Host target: $target_host"

  mkdir -p "$target_host"

  create_source_tar | tar -xf - -C "$target_host"

  info "Host-mount deployment completed."
  return 0
}

deploy_via_container_user() {
  info "Deploying via gateway container as default container user."

  create_source_tar | compose exec -T "$SERVICE" sh -lc "
    set -e
    mkdir -p '$TARGET_CONTAINER'
    tar -xf - -C '$TARGET_CONTAINER'
  "
}

deploy_via_container_root() {
  warn "Default container-user deployment failed."
  warn "Retrying as root inside the gateway container, then chowning only the plugin directory to node:node."

  create_source_tar | compose exec -T -u root "$SERVICE" sh -lc "
    set -e
    mkdir -p '$TARGET_CONTAINER'
    tar -xf - -C '$TARGET_CONTAINER'
    chown -R node:node '$TARGET_CONTAINER' || true
    chmod -R u+rwX,go+rX '$TARGET_CONTAINER' || true
  "
}

deploy_files() {
  local openclaw_config_dir="$1"

  info "OpenClaw config dir from .env/fallback: $openclaw_config_dir"
  info "Container deploy target: $TARGET_CONTAINER"

  if deploy_via_host_mount_if_possible "$openclaw_config_dir"; then
    return 0
  fi

  warn "Falling back to container-based deployment."
  ensure_gateway_running

  if deploy_via_container_user; then
    info "Container deployment completed as default user."
  else
    deploy_via_container_root
    info "Container deployment completed as root fallback."
  fi
}

restart_gateway() {
  info "Restarting gateway so plugin code is reloaded..."

  if compose restart "$SERVICE"; then
    info "Normal gateway restart command completed."
  else
    hard_restart_gateway
  fi

  wait_for_gateway 90 || {
    warn "Gateway healthcheck failed after restart. Recent gateway logs:"
    compose logs --tail 120 "$SERVICE" || true
    exit 2
  }
}

verify_inside_container() {
  info "Verifying plugin files from inside the gateway container..."

  compose exec -T "$SERVICE" sh -lc "
    echo '----- openclaw version -----'
    openclaw --version || true

    echo '----- plugin config -----'
    openclaw config get plugins || true

    echo '----- plugin files -----'
    find '$TARGET_CONTAINER' -maxdepth 3 -type f | sort

    echo '----- package.json -----'
    cat '$TARGET_CONTAINER/package.json' || true

    echo '----- root index.js -----'
    cat '$TARGET_CONTAINER/index.js' || true

    echo '----- recent guardrail log -----'
    tail -n 50 /home/node/.openclaw/guardrail-enforce.log 2>/dev/null || true
  "
}

check_no_gateway_run_containers() {
  info "Checking gateway containers..."
  docker ps -a --filter "name=openclaw-openclaw-gateway" --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"
}

main() {
  info "Plugin repo: $PROJECT_ROOT"
  info "OpenClaw repo: $OPENCLAW_REPO"

  check_required_files

  OPENCLAW_CONFIG_DIR="$(read_openclaw_config_dir)"

  deploy_files "$OPENCLAW_CONFIG_DIR"
  restart_gateway
  verify_inside_container
  check_no_gateway_run_containers

  info "Deployment complete."
  info "Next: test in the WebUI with a simple pwd exec prompt."
}

main "$@"
