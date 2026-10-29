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
FIXTURES="$ROOT/test/fixtures"
mkdir -p /tmp/opencode

# The relay station needs an account and a key; without them it stays off.
if grep -q TOKEN_RHYTHM_1_API_KEY .env 2>/dev/null; then
  export TOKENRHYTHM=true
fi

rm -rf "$FIXTURES"
mkdir -p "$FIXTURES"

# The China region answers slowly and does not go through the proxy, so it is
# recorded on its own.
node --experimental-strip-types test/capture-legacy.ts || true

node --experimental-strip-types test/record-proxy.ts "$PROXY_PORT" > /tmp/opencode/record-proxy.log 2>&1 &
PROXY_PID=$!

# 网关交给 test/serve.ts：端口由共享 helper 挑，上游指向录制代理。
READY="$(mktemp -d)/ready.json"
node --experimental-strip-types test/serve.ts --upstream "http://127.0.0.1:$PROXY_PORT" \
  --ready-file "$READY" > /tmp/opencode/capture-serve.log 2>&1 &
ROUTER_PID=$!

cleanup() {
  kill $ROUTER_PID $PROXY_PID 2>/dev/null
  wait $ROUTER_PID $PROXY_PID 2>/dev/null
}
trap cleanup EXIT

for _ in $(seq 1 120); do
  [ -f "$READY" ] && break
  kill -0 $ROUTER_PID 2>/dev/null || break
  sleep 0.5
done
BASE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["base"])' "$READY" 2>/dev/null)"
if [ -z "$BASE" ]; then
  echo "the router did not start:"
  tail -20 /tmp/opencode/capture-serve.log
  exit 1
fi

E2E_SKIP="qoder-cn" bash test/e2e.sh "$BASE"
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
