#!/usr/bin/env bash
# Record the upstream responses into fixtures.
#
#   test/capture.sh
#
# Runs the whole matrix against the real upstreams through a recording proxy,
# so every response the router saw is written down. The mock server replays
# them afterwards, which is what the test runs against.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROXY_PORT="${PROXY_PORT:-6699}"
ROUTER_PORT="${ROUTER_PORT:-6698}"
FIXTURES="$ROOT/test/fixtures"

# The MiniMax upstream of the recording proxy: the real one.
export MINIMAX_UPSTREAM_URL="${MINIMAX_UPSTREAM_URL:-http://192.168.50.4:6448}"

rm -rf "$FIXTURES"
mkdir -p "$FIXTURES"

# The China region answers slowly and does not go through the proxy, so it is
# recorded on its own.
node --experimental-strip-types test/capture-legacy.ts || true

node --experimental-strip-types test/record-proxy.ts "$PROXY_PORT" > /tmp/opencode/record-proxy.log 2>&1 &
PROXY_PID=$!
bash test/run-router.sh "$ROUTER_PORT" "http://127.0.0.1:$PROXY_PORT" > /tmp/opencode/capture-router.log 2>&1 &
ROUTER_PID=$!

cleanup() {
  kill $ROUTER_PID $PROXY_PID 2>/dev/null
  wait $ROUTER_PID $PROXY_PID 2>/dev/null
}
trap cleanup EXIT

# The router has to be the one this script started, on a free port.
for _ in $(seq 1 60); do
  if ! kill -0 $ROUTER_PID 2>/dev/null; then
    echo "the router did not start:"
    tail -5 /tmp/opencode/capture-router.log
    exit 1
  fi
  curl -s --noproxy '*' -m 2 "http://127.0.0.1:$ROUTER_PORT/health" > /dev/null && break
  sleep 0.5
done

E2E_SKIP="qoder-cn" bash test/e2e.sh "http://127.0.0.1:$ROUTER_PORT"
status=$?

# The China region answers slowly, so the recorder may still be waiting for it.
# Give it a moment to write the answer down before it is stopped.
echo
echo "waiting for the recorder to finish..."
sleep 20

echo
echo "--- fixtures ---"
ls -la "$FIXTURES" | tail -n +2
echo
echo "--- recorded ---"
cat /tmp/opencode/record-proxy.log | grep recorded || echo "(nothing recorded)"
exit $status
