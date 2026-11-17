#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/.trueforge"
export SQLITE_PATH="$ROOT/.trueforge/trueforge.sqlite"
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
export MODEL_HTTP_HEADERS_TIMEOUT_MS=180000
export MODEL_HTTP_BODY_TIMEOUT_MS=300000
export MCP_REQUEST_TIMEOUT_MS=600000
export PORT="${PORT:-8790}"
exec npx -y @truefoundry/trueforge@latest
