#!/bin/bash

echo "=========================================="
echo " WhatsApp WuzAPI — Docker Launcher"
echo " wuzapi + relay + cloudflared"
echo "=========================================="

# Load environment variables from wuzapi.env if present
if [ -f /app/wuzapi.env ]; then
  echo "[init] Loading wuzapi.env..."
  set -a
  . /app/wuzapi.env
  set +a
fi

WUZAPI_PORT=${WUZAPI_PORT:-8080}
WUZAPI_ADDRESS=${WUZAPI_ADDRESS:-0.0.0.0}
WUZAPI_ADMIN_TOKEN=${WUZAPI_ADMIN_TOKEN:-change-me}
WUZAPI_ENCRYPTION_KEY=${WUZAPI_ENCRYPTION_KEY:-change-me-change-me-change-me12}
WUZAPI_HMAC_KEY=${WUZAPI_HMAC_KEY:-change-me-change-me-change-me-change-me12}
WUZAPI_WEBHOOK_URL=${WUZAPI_WEBHOOK_URL:-}
WUZAPI_BIN=${WUZAPI_BIN:-/app/wuzapi}

cleanup() {
  echo ""
  echo "[shutdown] Stopping all services..."
  kill $WUZAPI_PID $RELAY_PID $TUNNEL_PID 2>/dev/null || true
  wait $WUZAPI_PID $RELAY_PID $TUNNEL_PID 2>/dev/null || true
  echo "[shutdown] Done."
  exit 0
}

trap cleanup SIGINT SIGTERM

# --- Start wuzapi ---
echo "[init] Starting wuzapi on ${WUZAPI_ADDRESS}:${WUZAPI_PORT}..."
"$WUZAPI_BIN" \
  -port "$WUZAPI_PORT" \
  -address "$WUZAPI_ADDRESS" \
  -logtype console -color \
  -admintoken "$WUZAPI_ADMIN_TOKEN" \
  -globalencryptionkey "$WUZAPI_ENCRYPTION_KEY" \
  -globalhmackey "$WUZAPI_HMAC_KEY" \
  ${WUZAPI_WEBHOOK_URL:+-globalwebhook "$WUZAPI_WEBHOOK_URL"} &
WUZAPI_PID=$!
echo "[init] wuzapi PID: $WUZAPI_PID"

sleep 2

# --- Start relay ---
echo "[init] Starting relay on :3100..."
python3 /app/relay.py &
RELAY_PID=$!
echo "[init] relay PID: $RELAY_PID"

sleep 1

# --- Start cloudflared ---
echo "[init] Starting cloudflared tunnel to localhost:${WUZAPI_PORT}..."
/app/cloudflared tunnel --url "http://localhost:${WUZAPI_PORT}" &
TUNNEL_PID=$!
echo "[init] cloudflared PID: $TUNNEL_PID"

echo ""
echo "=========================================="
echo " All services running. Ctrl+C to stop."
echo "=========================================="

# Monitor — restart crashed services
while true; do
  sleep 5

  if ! kill -0 $WUZAPI_PID 2>/dev/null; then
    echo "[watch] wuzapi crashed, restarting..."
    "$WUZAPI_BIN" \
      -port "$WUZAPI_PORT" \
      -address "$WUZAPI_ADDRESS" \
      -logtype console -color \
      -admintoken "$WUZAPI_ADMIN_TOKEN" \
      -globalencryptionkey "$WUZAPI_ENCRYPTION_KEY" \
      -globalhmackey "$WUZAPI_HMAC_KEY" \
      ${WUZAPI_WEBHOOK_URL:+-globalwebhook "$WUZAPI_WEBHOOK_URL"} &
    WUZAPI_PID=$!
  fi

  if ! kill -0 $RELAY_PID 2>/dev/null; then
    echo "[watch] relay crashed, restarting..."
    python3 /app/relay.py &
    RELAY_PID=$!
  fi

  if ! kill -0 $TUNNEL_PID 2>/dev/null; then
    echo "[watch] cloudflared crashed, restarting..."
    /app/cloudflared tunnel --url "http://localhost:${WUZAPI_PORT}" &
    TUNNEL_PID=$!
  fi
done
