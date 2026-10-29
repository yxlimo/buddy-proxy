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
#
# The panel's side of it goes through Connect now: POST
# /buddy.admin.v1.AdminService/<method> with the panel's token.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export BUDDY_DATA_DIR="${BUDDY_DATA_DIR:-/tmp/opencode/test-aggregate}"
mkdir -p /tmp/opencode
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

# The sessions of the two upstreams the requests need go into the test's own
# database. The mock upstream does not look at the credential, but the router
# does: without a session there is nothing to send. (They used to come from the
# machine's own files, which is why this test needed a machine that had been
# logged in.)
node --experimental-strip-types test/aggregate-setup.ts seed

# 网关与假上游交给 test/serve.ts（端口由共享 helper 挑，撞了换号重来）。
READY="$(mktemp -d)/ready.json"
node --experimental-strip-types test/serve.ts --mock --data-dir "$BUDDY_DATA_DIR" \
  --ready-file "$READY" > /tmp/opencode/aggregate-serve.log 2>&1 &
ROUTER_PID=$!

cleanup() {
  kill $ROUTER_PID 2>/dev/null
  wait $ROUTER_PID 2>/dev/null
}
trap cleanup EXIT

for _ in $(seq 1 120); do
  [ -f "$READY" ] && break
  kill -0 $ROUTER_PID 2>/dev/null || break
  sleep 0.5
done

BASE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["base"])' "$READY" 2>/dev/null)"
TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$READY" 2>/dev/null)"
if [ -z "$BASE" ]; then
  echo "the router did not start:"
  tail -20 /tmp/opencode/aggregate-serve.log
  exit 1
fi
ADMIN="$BASE/buddy.admin.v1.AdminService"

# One Connect call: the method, the body, and the answer.
admin() {
  local method="$1" body="${2:-{\}}"
  curl -fsS -X POST "$ADMIN/$method" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $TOKEN" \
    -d "$body"
}

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

saved=$(admin SavePublishedModel '{"model":{"id":"smart","displayName":"Smart","strategy":"fallback","enabled":true,"targets":[{"groupName":"qoder","upstreamModel":"glm-5.3","weight":1,"position":0,"enabled":true},{"groupName":"workbuddy-cn","upstreamModel":"glm-5.3-flash","weight":1,"position":1,"enabled":true}]}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')
[ "$saved" = "True" ] && check "the panel can save a model" 1 || check "the panel can save a model" 0

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

usage=$(admin GetUsageSummary '{}')
first=$(echo "$usage" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(int(b["summary"]["failed"]) for b in d.get("byUpstream",[]) if b["key"]=="qoder"))')
second=$(echo "$usage" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(int(b["summary"]["succeeded"]) for b in d.get("byUpstream",[]) if b["key"]=="workbuddy-cn"))')
[ "$first" -ge 1 ] && check "the failure is counted against the first target" 1 || check "the failure is counted against the first target" 0
[ "$second" -ge 1 ] && check "the success is counted against the second target" 1 || check "the success is counted against the second target" 0

events=$(admin ListUsageEvents '{"limit":50}')
rows=$(echo "$events" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("events",[])))')
[ "$rows" -ge 1 ] && check "the traffic shows up in the events" 1 || check "the traffic shows up in the events" 0

echo ""
echo "the panel"

listed=$(admin ListPublishedModels '{}' | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("models",[])))')
[ "$listed" -ge 1 ] && check "the panel can read the models back" 1 || check "the panel can read the models back" 0

# A model that is not published is not served, and saving one is enough.
before=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"from-panel","messages":[{"role":"user","content":"hi"}]}')
[ "$before" = "404" ] && check "an unsaved model is not served" 1 || check "an unsaved model is not served" 0

saved=$(admin SavePublishedModel '{"model":{"id":"from-panel","displayName":"From the panel","strategy":"single","enabled":true,"targets":[{"groupName":"qoder","upstreamModel":"glm-5.3","weight":1,"position":0,"enabled":true}]}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')
[ "$saved" = "True" ] && check "the panel can save a model" 1 || check "the panel can save a model" 0

after=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"from-panel","messages":[{"role":"user","content":"hi"}]}')
[ "$after" = "200" ] && check "a saved model is live right away" 1 || check "a saved model is live right away" 0

# A published model whose target speaks Anthropic natively (MiniMax Code):
# the answer must name the published model, not the upstream's own name.
admin SavePublishedModel '{"model":{"id":"anthropic-native","displayName":"Anthropic native","strategy":"single","enabled":true,"targets":[{"groupName":"minimax","upstreamModel":"MiniMax-M3.1-Flash","weight":1,"position":0,"enabled":true}]}}' > /dev/null
native=$(curl -s -X POST "$BASE/v1/messages" \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"anthropic-native","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}')
named=$(echo "$native" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("model"))')
[ "$named" = "anthropic-native" ] && check "an Anthropic-native upstream answers with the published name" 1 || check "an Anthropic-native upstream answers with the published name" 0

native_stream=$(curl -s -X POST "$BASE/v1/messages" \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"anthropic-native","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}]}')
echo "$native_stream" | grep -q '"model":"anthropic-native"' && check "its stream names the published model too" 1 || check "its stream names the published model too" 0
admin DeletePublishedModel '{"id":"anthropic-native"}' > /dev/null

deleted=$(admin DeletePublishedModel '{"id":"from-panel"}' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')
[ "$deleted" = "True" ] && check "the panel can delete a model" 1 || check "the panel can delete a model" 0

gone=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"from-panel","messages":[{"role":"user","content":"hi"}]}')
[ "$gone" = "404" ] && check "a deleted model is gone" 1 || check "a deleted model is gone" 0

echo ""
echo "the traffic"

tokens=$(echo "$usage" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(int(d.get("total",{}).get("completionTokens",0) or 0))')
[ "$tokens" -gt 0 ] && check "the tokens are counted" 1 || check "the tokens are counted" 0

echo ""
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" = "0" ] || exit 1
