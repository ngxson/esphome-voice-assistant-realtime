#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load env vars from project root .env
if [ -f "../.env" ]; then
  export $(grep -v '^#' ../.env | xargs)
fi

IMAGE="esphome-voice-assistant-server-dev"

echo "[dev] Building..."
docker build \
  --build-arg BUILD_FROM=alpine:3.18 \
  -t "$IMAGE" .

echo "[dev] Running..."
docker run --rm \
  -p "${WEBSOCKET_PORT:-8080}:${WEBSOCKET_PORT:-8080}" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e WEBSOCKET_PORT="${WEBSOCKET_PORT:-8080}" \
  -e MODEL="${MODEL:-gpt-realtime-mini}" \
  -e VOICE="${VOICE:-sage}" \
  -e INSTRUCTIONS="${INSTRUCTIONS:-You are a helpful home assistant voice assistant. Be concise in your responses.}" \
  -e SESSION_REUSE_TIMEOUT_SECONDS="${SESSION_REUSE_TIMEOUT_SECONDS:-5}" \
  -e IDLE_TIMEOUT_SECONDS="${IDLE_TIMEOUT_SECONDS:-3}" \
  -e OUTPUT_GAIN="${OUTPUT_GAIN:-1.0}" \
  -e ENABLE_HA_TOOLS="${ENABLE_HA_TOOLS:-false}" \
  -e HA_MCP_URL="${HA_MCP_URL:-}" \
  -e HA_TOKEN="${HA_TOKEN:-}" \
  -e ENABLE_RECORDING="${ENABLE_RECORDING:-false}" \
  "$IMAGE" \
  node /app/dist/index.js
