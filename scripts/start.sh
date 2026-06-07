#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8788}"
WORKBENCH_DB="${WORKBENCH_DB:-$ROOT_DIR/data/workbench.sqlite}"
BUILD="${BUILD:-1}"
INSTALL="${INSTALL:-1}"

mkdir -p "$(dirname "$WORKBENCH_DB")"

if [[ "$INSTALL" == "1" && ! -d node_modules ]]; then
  echo "[workbench] installing dependencies with npm ci"
  npm ci
fi

if [[ "$BUILD" == "1" || ! -f dist/server/server/index.js || ! -f dist/client/index.html ]]; then
  echo "[workbench] building production bundle"
  npm run build
fi

export HOST PORT WORKBENCH_DB

echo "[workbench] starting on http://$HOST:$PORT"
echo "[workbench] database: $WORKBENCH_DB"
exec npm run start
