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

# The test starts from an empty database: whatever an earlier run left behind
# (a snapshot in the old shape, a session that is gone) would answer with
# numbers that are not there any more. The gateway now makes its own temporary
# one (test/serve.ts), so there is nothing here to clean up.
FIXTURES="$ROOT/test/fixtures"
mkdir -p /tmp/opencode

if [ ! -d "$FIXTURES" ] || [ -z "$(ls -A "$FIXTURES" 2>/dev/null)" ]; then
  echo "no fixtures yet — run test/capture.sh first"
  exit 1
fi

# The relay station needs an account and a key; without them it stays off.
# The upstream switch lives in the database now, so the test turns it on there
# (test/fake-sessions.ts does it) instead of through an environment variable.
if grep -q TOKEN_RHYTHM_1_API_KEY .env 2>/dev/null; then
  export TEST_UPSTREAMS="qoder,qoder-cn,workbuddy-cn,minimax,tokenrhythm"
else
  export TEST_UPSTREAMS="qoder,qoder-cn,workbuddy-cn,minimax"
fi

# 网关与假上游都交给 test/serve.ts 起：端口由共享 helper 挑（撞了就换号重来），
# 起来之后它把基址写进 ready 文件；收尾时它自己把网关与假上游都收掉。
READY="$(mktemp -d)/ready.json"
node --experimental-strip-types test/serve.ts --mock --ready-file "$READY" \
  --env "TEST_UPSTREAMS=$TEST_UPSTREAMS" \
  --log-file /tmp/opencode/smoke-router.log > /tmp/opencode/smoke-serve.log 2>&1 &
ROUTER_PID=$!

cleanup() {
  kill $ROUTER_PID 2>/dev/null
  wait $ROUTER_PID 2>/dev/null
}
trap cleanup EXIT

# 挑端口那一手有半秒的空窗，所以用 ready 文件当准 —— 不是抡 curl 猜。
BASE=""
for _ in $(seq 1 120); do
  if [ -f "$READY" ]; then
    BASE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["base"])' "$READY" 2>/dev/null)"
    [ -n "$BASE" ] && break
  fi
  if ! kill -0 $ROUTER_PID 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if [ -z "$BASE" ]; then
  echo "the router did not start:"
  tail -20 /tmp/opencode/smoke-serve.log
  exit 1
fi

bash test/e2e.sh "$BASE"
status=$?

# The settings layer is checked on its own: the order the three sources are
# read in is what decides how the service behaves.
echo ""
node --experimental-strip-types test/config-check.ts
config_status=$?
if [ $config_status -ne 0 ]; then
  status=$config_status
fi

# The parts of the WorkBuddy client that were changed to match the official
# one are checked on their own too.
echo ""
node --experimental-strip-types test/workbuddy-check.ts
wb_status=$?
if [ $wb_status -ne 0 ]; then
  status=$wb_status
fi

# The two upstreams that came later (SenseNova and 书生·端砚): the catalogue,
# a request, the credits and the state. Against a fake upstream — no credits
# are spent.
echo ""
node --experimental-strip-types test/sensenova-intern-ai-check.ts
sn_status=$?
if [ $sn_status -ne 0 ]; then
  status=$sn_status
fi

if [ "$status" -ne 0 ]; then
  echo "--- router log ---"
  tail -20 /tmp/opencode/smoke-router.log
fi
exit $status
