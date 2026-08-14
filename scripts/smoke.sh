#!/usr/bin/env bash
#
# SplatScene end-to-end smoke check (WP 0.4).
#
# Brings up the minimum stack — Redis + the API with QUEUE_MODE=celery and
# EVENT_SOURCE=redis — then runs scripts/smoke_e2e.py, which uploads a photo,
# creates a job, starts the Celery worker and asserts that progress reaches the
# WebSocket and the job ends 'done' with an artifact on disk.
#
#   ./scripts/smoke.sh
#
# Requirements: redis-server (or a reachable REDIS_URL), the api virtualenv and
# a Python with the worker's dependencies installed. Overridable:
#
#   API_PYTHON=api/.venv/bin/python        interpreter running uvicorn + client
#   WORKER_PYTHON=worker/.venv/bin/python  interpreter running celery
#   REDIS_URL=redis://127.0.0.1:6399/0     reused if already reachable
#   API_PORT=8099                          port for the smoke API instance
#
# Everything it starts, it stops; state lives in a temp dir that is removed on
# exit. Nothing touches the developer's ./data.
#
# Docker equivalent (same assertions against the compose stack):
#
#   docker compose up -d --build redis api worker
#   API_BASE_URL=http://localhost:8000 STORAGE_DIR=... python scripts/smoke_e2e.py
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PYTHON="${API_PYTHON:-$ROOT/api/.venv/bin/python}"
WORKER_PYTHON="${WORKER_PYTHON:-$ROOT/worker/.venv/bin/python}"
API_PORT="${API_PORT:-8099}"
REDIS_PORT="${REDIS_PORT:-6399}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:${REDIS_PORT}/0}"

fail() { echo "smoke: $*" >&2; exit 1; }

[ -x "$API_PYTHON" ] || fail "API_PYTHON not executable: $API_PYTHON (create api/.venv or set API_PYTHON)"
[ -x "$WORKER_PYTHON" ] || fail "WORKER_PYTHON not executable: $WORKER_PYTHON (set WORKER_PYTHON)"

WORKDIR="$(mktemp -d)"
REDIS_PID=""
API_PID=""

cleanup() {
  local status=$?
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$REDIS_PID" ] && kill "$REDIS_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORKDIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

# --- Redis ------------------------------------------------------------------
if command -v redis-cli >/dev/null 2>&1 && redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then
  echo "smoke: reusing Redis at $REDIS_URL"
else
  command -v redis-server >/dev/null 2>&1 || fail "no redis-server and nothing listening on $REDIS_URL"
  echo "smoke: starting redis-server on port $REDIS_PORT"
  redis-server --port "$REDIS_PORT" --save '' --appendonly no --daemonize no \
    >"$WORKDIR/redis.log" 2>&1 &
  REDIS_PID=$!
  for _ in $(seq 1 50); do
    redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1 && break
    sleep 0.2
  done
  redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1 || fail "redis did not come up (see $WORKDIR/redis.log)"
fi

# --- API --------------------------------------------------------------------
export DATABASE_URL="sqlite:///$WORKDIR/smoke.db"
export STORAGE_DIR="$WORKDIR/photos"
export REDIS_URL
export QUEUE_MODE=celery
export EVENT_SOURCE=redis
export DEV_MODE=0

echo "smoke: starting API on port $API_PORT (QUEUE_MODE=celery EVENT_SOURCE=redis)"
(cd "$ROOT/api" && "$API_PYTHON" -m uvicorn app.main:app \
  --host 127.0.0.1 --port "$API_PORT" --log-level warning) >"$WORKDIR/api.log" 2>&1 &
API_PID=$!

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1 \
  || { cat "$WORKDIR/api.log" >&2; fail "API did not come up"; }

# --- End-to-end assertions --------------------------------------------------
echo "smoke: running end-to-end check"
API_BASE_URL="http://127.0.0.1:$API_PORT" \
WS_BASE_URL="ws://127.0.0.1:$API_PORT" \
STORAGE_DIR="$STORAGE_DIR" \
REDIS_URL="$REDIS_URL" \
WORKER_PYTHON="$WORKER_PYTHON" \
  "$API_PYTHON" "$ROOT/scripts/smoke_e2e.py" || { cat "$WORKDIR/api.log" >&2; fail "end-to-end check failed"; }

echo "smoke: OK"
