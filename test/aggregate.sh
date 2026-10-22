#!/usr/bin/env bash
# The published models: the root route's catalog and the fallback behind it.
#
#   test/aggregate.sh
#
# The root route publishes the models the database holds. With nothing in the
# database it publishes every upstream's models under their prefixed name — the
# list it always showed. Once the database holds a model, the database is the
# catalog, and a model with more than one target falls back to the next one
# when the first fails.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MOCK_PORT="${MOCK_PORT:-6709}"
ROUTER_PORT="${ROUTER_PORT:-6708}"
export BUDDY_DATA_DIR="${BUDDY_DATA_DIR:-/tmp/opencode/test-aggregate}"
PASS=0
FAIL=0

check() {
  local name="$1" ok="$2"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    echo "  ok   $name"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL $name"
  fi
}

rm -rf "$BUDDY_DATA_DIR"
mkdir -p "$BUDDY_DATA_DIR"

node --experimental-strip-types test/mock-server.ts "$MOCK_PORT" > /tmp/opencode/aggregate-mock.log 2>&1 &
MOCK_PID=$!
bash test/run-router.sh "$ROUTER_PORT" "http://127.0.0.1:$MOCK_PORT" > /tmp/opencode/aggregate-router.log 2>&1 &
ROUTER_PID=$!

cleanup() {
  kill $ROUTER_PID $MOCK_PID 2>/dev/null
  wait $ROUTER_PID $MOCK_PID 2>/dev/null
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$ROUTER_PORT/health" > /dev/null 2>&1; then break; fi
  sleep 0.25
done

BASE="http://127.0.0.1:$ROUTER_PORT"

echo ""
echo "the aggregate catalog"

# With nothing configured the root route has nothing to publish.
code=$(curl -s -o /tmp/opencode/aggregate-empty.json -w '%{http_code}' "$BASE/v1/models")
[ "$code" = "404" ] && check "the empty database publishes nothing" 1 || check "the empty database publishes nothing" 0

# And a model that is not published is not served.
code=$(curl -s -o /tmp/opencode/aggregate-unknown.json -w '%{http_code}' \
  -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"qoder/glm-5.3","messages":[{"role":"user","content":"hi"}]}')
[ "$code" = "404" ] && check "an unpublished model is refused" 1 || check "an unpublished model is refused" 0

# The upstream's own path still works, the way it always did.
code=$(curl -s -o /tmp/opencode/aggregate-auto.json -w '%{http_code}' \
  -X POST "$BASE/qoder/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"hi"}]}')
[ "$code" = "200" ] && check "an upstream's own path still answers" 1 || check "an upstream's own path still answers" 0

echo ""
echo "a model from the database"

node --experimental-strip-types test/aggregate-setup.ts save "smart" "Smart" "fallback" \
  "qoder:glm-5.3" "workbuddy-cn:glm-5.3-flash" > /dev/null
curl -fsS -X POST "$BASE/admin/reload" > /dev/null

count=$(curl -fsS "$BASE/v1/models" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]))')
[ "$count" = "1" ] && check "the database is the catalog" 1 || check "the database is the catalog" 0

name=$(curl -fsS "$BASE/v1/models" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])')
[ "$name" = "smart" ] && check "the published model has the panel's name" 1 || check "the published model has the panel's name" 0

code=$(curl -s -o /tmp/opencode/aggregate-smart.json -w '%{http_code}' \
  -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"smart","messages":[{"role":"user","content":"hi"}]}')
[ "$code" = "200" ] && check "the published model answers" 1 || check "the published model answers" 0

echo ""
echo "the fallback"

# The first target has no fixture in the mock, so it fails; the second answers.
node --experimental-strip-types test/aggregate-setup.ts clear-usage > /dev/null
code=$(curl -s -o /tmp/opencode/aggregate-fallback.json -w '%{http_code}' \
  -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"smart","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"f","description":"d","parameters":{"type":"object","properties":{}}}}]}')
[ "$code" = "200" ] && check "the second target answers" 1 || check "the second target answers" 0

usage=$(curl -fsS "$BASE/admin/usage")
first=$(echo "$usage" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(sum(r["failed"] for r in d if r["group"]=="qoder"))')
second=$(echo "$usage" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(sum(r["succeeded"] for r in d if r["group"]=="workbuddy-cn"))')
[ "$first" -ge 1 ] && check "the failure is counted against the first target" 1 || check "the failure is counted against the first target" 0
[ "$second" -ge 1 ] && check "the success is counted against the second target" 1 || check "the success is counted against the second target" 0

echo ""
echo "the panel"

saved=$(curl -fsS -X POST "$BASE/admin/models" -H 'content-type: application/json' \
  -d '{"id":"from-panel","displayName":"From the panel","strategy":"single","targets":[{"group":"qoder","upstreamModel":"glm-5.3"}]}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("saved"))')
[ "$saved" = "True" ] && check "the panel can save a model" 1 || check "the panel can save a model" 0

listed=$(curl -fsS "$BASE/admin/models" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]))')
[ "$listed" -ge 1 ] && check "the panel can read the models back" 1 || check "the panel can read the models back" 0

# The save does not change anything until the panel asks for it.
before=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"from-panel","messages":[{"role":"user","content":"hi"}]}')
[ "$before" = "404" ] && check "a saved model waits for the reload" 1 || check "a saved model waits for the reload" 0

curl -fsS -X POST "$BASE/admin/reload" > /dev/null
after=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"from-panel","messages":[{"role":"user","content":"hi"}]}')
[ "$after" = "200" ] && check "the reload makes the saved model live" 1 || check "the reload makes the saved model live" 0

deleted=$(curl -fsS -X DELETE "$BASE/admin/models/from-panel" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("deleted"))')
[ "$deleted" = "True" ] && check "the panel can delete a model" 1 || check "the panel can delete a model" 0

echo ""
echo "the traffic"

tokens=$(echo "$usage" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(sum(r.get("completionTokens") or 0 for r in d))')
[ "$tokens" -gt 0 ] && check "the tokens are counted" 1 || check "the tokens are counted" 0

echo ""
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" = "0" ] || exit 1
