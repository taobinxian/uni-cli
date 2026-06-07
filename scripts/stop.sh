#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${WORKBENCH_PID_FILE:-$ROOT_DIR/data/workbench.pid}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "[workbench] pid file not found: $PID_FILE"
  exit 0
fi

PID="$(cat "$PID_FILE" || true)"
if [[ -z "$PID" ]]; then
  rm -f "$PID_FILE"
  echo "[workbench] empty pid file removed"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "[workbench] process $PID is not running"
  exit 0
fi

echo "[workbench] stopping process $PID"
kill "$PID" 2>/dev/null || true
for _ in {1..30}; do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "[workbench] stopped"
    exit 0
  fi
  sleep 0.2
done

echo "[workbench] process $PID is still running; sending SIGKILL"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "[workbench] stopped"
