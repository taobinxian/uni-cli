#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8788}"
WORKBENCH_DB="${WORKBENCH_DB:-$ROOT_DIR/data/workbench.sqlite}"
PID_FILE="${WORKBENCH_PID_FILE:-$ROOT_DIR/data/workbench.pid}"
LOG_FILE="${WORKBENCH_LOG_FILE:-$ROOT_DIR/data/workbench.log}"
INSTALL="${INSTALL:-1}"
STOPPED_OLD="0"

mkdir -p "$(dirname "$WORKBENCH_DB")" "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

if [[ "$INSTALL" == "1" && ! -d node_modules ]]; then
  echo "[workbench] installing dependencies with npm ci"
  npm ci
fi

echo "[workbench] building production bundle"
npm run build

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[workbench] stopping previous process $OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    for _ in {1..30}; do
      if ! kill -0 "$OLD_PID" 2>/dev/null; then
        break
      fi
      sleep 0.2
    done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "[workbench] previous process did not exit, sending SIGKILL"
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    STOPPED_OLD="1"
  fi
fi

export HOST PORT WORKBENCH_DB

if [[ "$STOPPED_OLD" == "0" ]] && command -v curl >/dev/null 2>&1 && curl -fsS "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
  echo "[workbench] http://$HOST:$PORT is already serving a workbench instance that was not started by this script."
  echo "[workbench] stop that process first, or run with another PORT."
  exit 1
fi

echo "[workbench] launching background server on http://$HOST:$PORT"
nohup npm run start > "$LOG_FILE" 2>&1 &
NEW_PID="$!"
echo "$NEW_PID" > "$PID_FILE"

if command -v curl >/dev/null 2>&1; then
  for _ in {1..40}; do
    if curl -fsS "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
      echo "[workbench] healthy: http://$HOST:$PORT"
      echo "[workbench] pid: $NEW_PID"
      echo "[workbench] log: $LOG_FILE"
      exit 0
    fi
    sleep 0.25
  done
  echo "[workbench] server did not become healthy in time; tail the log:"
  echo "  tail -f $LOG_FILE"
  exit 1
fi

echo "[workbench] started pid $NEW_PID"
echo "[workbench] log: $LOG_FILE"
