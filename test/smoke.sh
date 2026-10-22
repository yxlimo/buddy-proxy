#!/usr/bin/env bash
# The self-test: the whole matrix against the recorded fixtures.
#
#   test/smoke.sh
#
# Nothing leaves the machine: the router talks to the mock server, which
# replays what the real upstreams answered. So the test costs no tokens and
# always sees the same answers.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MOCK_PORT="${MOCK_PORT:-6699}"
ROUTER_PORT="${ROUTER_PORT:-6698}"
FIXTURES="$ROOT/test/fixtures"

if [ ! -d "$FIXTURES" ] || [ -z "$(ls -A "$FIXTURES" 2>/dev/null)" ]; then
  echo "no fixtures yet — run test/capture.sh first"
  exit 1
fi

# The relay station needs an account and a key; without them it stays off.
if grep -q TOKEN_RHYTHM_1_API_KEY .env 2>/dev/null; then
  export TOKENRHYTHM=true
fi

node --experimental-strip-types test/mock-server.ts "$MOCK_PORT" > /tmp/opencode/mock-server.log 2>&1 &
MOCK_PID=$!
bash test/run-router.sh "$ROUTER_PORT" "http://127.0.0.1:$MOCK_PORT" > /tmp/opencode/smoke-router.log 2>&1 &
ROUTER_PID=$!

cleanup() {
  kill $ROUTER_PID $MOCK_PID 2>/dev/null
  wait $ROUTER_PID $MOCK_PID 2>/dev/null
}
trap cleanup EXIT

# The router has to be the one this script started, on a free port.
for _ in $(seq 1 60); do
  if ! kill -0 $ROUTER_PID 2>/dev/null; then
    echo "the router did not start:"
    tail -5 /tmp/opencode/smoke-router.log
    exit 1
  fi
  curl -s --noproxy '*' -m 2 "http://127.0.0.1:$ROUTER_PORT/health" > /dev/null && break
  sleep 0.5
done

bash test/e2e.sh "http://127.0.0.1:$ROUTER_PORT"
status=$?

# The settings layer is checked on its own: the order the three sources are
# read in is what decides how the service behaves.
echo ""
node --experimental-strip-types test/config-check.ts
config_status=$?
if [ $config_status -ne 0 ]; then
  status=$config_status
fi

if [ "$status" -ne 0 ]; then
  echo "--- router log ---"
  tail -20 /tmp/opencode/smoke-router.log
fi
exit $status
