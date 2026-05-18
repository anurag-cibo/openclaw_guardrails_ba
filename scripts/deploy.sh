#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_REPO="${OPENCLAW_REPO:-"$PROJECT_ROOT/../repo/openclaw"}"

COMPOSE_FILE_1="$OPENCLAW_REPO/docker-compose.yml"
COMPOSE_FILE_2="$OPENCLAW_REPO/docker-compose.ollama.override.yml"

SERVICE="openclaw-gateway"
TARGET="/home/node/.openclaw/local-plugins/guardrail-spike"

if [ ! -f "$COMPOSE_FILE_1" ]; then
  echo "[ERROR] docker-compose.yml not found: $COMPOSE_FILE_1" >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE_2" ]; then
  echo "[ERROR] docker-compose.ollama.override.yml not found: $COMPOSE_FILE_2" >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/package.json" ]; then
  echo "[ERROR] package.json not found in plugin repo: $PROJECT_ROOT" >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/openclaw.plugin.json" ]; then
  echo "[ERROR] openclaw.plugin.json not found in plugin repo: $PROJECT_ROOT" >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/src/index.js" ]; then
  echo "[ERROR] src/index.js not found in plugin repo: $PROJECT_ROOT" >&2
  exit 1
fi

echo "[INFO] Plugin repo: $PROJECT_ROOT"
echo "[INFO] OpenClaw repo: $OPENCLAW_REPO"
echo "[INFO] Deploy target inside container: $TARGET"

cd "$PROJECT_ROOT"

echo "[INFO] Ensuring gateway service is running..."
docker compose -f "$COMPOSE_FILE_1" -f "$COMPOSE_FILE_2" up -d "$SERVICE"

echo "[INFO] Creating target directory inside container..."
docker compose -f "$COMPOSE_FILE_1" -f "$COMPOSE_FILE_2" exec -T "$SERVICE" sh -lc "mkdir -p '$TARGET'"

echo "[INFO] Copying plugin files into container target..."
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='*.log' \
  --exclude='*.jsonl' \
  -cf - \
  package.json \
  openclaw.plugin.json \
  src \
  tests \
  scripts \
  docs \
  README.md \
| docker compose -f "$COMPOSE_FILE_1" -f "$COMPOSE_FILE_2" exec -T "$SERVICE" sh -lc "tar -xf - -C '$TARGET'"

echo "[INFO] Restarting OpenClaw gateway to load plugin changes..."
docker compose -f "$COMPOSE_FILE_1" -f "$COMPOSE_FILE_2" restart "$SERVICE"

echo "[INFO] Done. Check plugin load logs with:"
echo "docker compose -f $COMPOSE_FILE_1 -f $COMPOSE_FILE_2 exec -T $SERVICE sh -lc 'tail -n 30 /home/node/.openclaw/guardrail-enforce.log'"
