#!/usr/bin/env bash
# The end-to-end matrix: every upstream, in both dialects, streaming and not.
#
#   test/e2e.sh <base-url>
#
# Prints one line per case and a summary. The base URL is the router; the
# upstream behind it may be the real one, the recording proxy or the mock.
set -uo pipefail

BASE="${1:?usage: e2e.sh <base-url>}"
BASE="${BASE%/}"

# The groups to leave out, e.g. when a group is recorded on its own because
# its upstream is slow.
SKIP="${E2E_SKIP:-}"

skip() {
  case " $SKIP " in *" $1 "*) return 0;; esac
  return 1
}

# The China region answers slowly — the model thinks a lot — so the wait is long.
TIMEOUT="${E2E_TIMEOUT:-300}"

pass=0
fail=0

report() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    printf '  ok   %-44s %s\n' "$name" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL %-44s want=%s got=%s\n' "$name" "$want" "$got"
    fail=$((fail + 1))
  fi
}

# The class of a status code: 2xx, 4xx, 5xx and whatever else it was.
status_class() {
  case "${1:-000}" in
    2??) echo "2xx" ;;
    3??) echo "3xx" ;;
    4??) echo "4xx" ;;
    5??) echo "5xx" ;;
    *) echo "${1:-none}" ;;
  esac
}

# The model lists, per upstream. The root route publishes what the panel
# configured, so it is not part of this list.
for group in qoder qoder-cn workbuddy-cn minimax; do
  path="${group:+$group/}v1/models"
  n=$(curl -s --noproxy '*' -m 20 "$BASE/$path" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]))' 2>/dev/null)
  if [ "${n:-0}" -gt 0 ]; then printf '  ok   %-44s %s models\n' "models $path" "$n"; pass=$((pass + 1)); else printf '  FAIL %-44s no models\n' "models $path"; fail=$((fail + 1)); fi
done

# Every model in the list carries the metadata a client needs: how much it
# reads and how much it may answer. A model the gateway says nothing about
# the context window of has no context window here either.
for group in qoder qoder-cn workbuddy-cn minimax; do
  got=$(curl -s --noproxy '*' -m 20 "$BASE/$group/v1/models" | python3 -c '
import json,sys
data = json.load(sys.stdin)["data"]
bad = [m.get("id") for m in data
       if not m.get("max_output_tokens")
       or (m.get("context_window") is not None and m.get("context_window") <= 0)]
print("ok" if data and not bad else "bad: " + ", ".join(map(str, bad[:3])))
' 2>/dev/null)
  report "models $group metadata" "ok" "$got"
done

# One request per upstream and dialect.
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

for spec in "qoder:glm-5.3" "qoder-cn:glm-5.3" "workbuddy-cn:hy3" "minimax:MiniMax-M3.1-Flash" "tokenrhythm:deepseek-v4.1-flash-1017"; do
  group="${spec%%:*}"
  model="${spec##*:}"
  skip "$group" && continue
  for dialect in anthropic openai; do
    if [ "$dialect" = "openai" ]; then path="v1/chat/completions"; else path="v1/messages"; fi
    body="{\"model\":\"$model\",\"max_tokens\":32,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}]}"

    status=$(curl -s --noproxy '*' -m $TIMEOUT -X POST "$BASE/$group/$path" \
      -H 'content-type: application/json' -H 'x-api-key: public' \
      -H 'anthropic-version: 2023-06-01' -d "$body" \
      -o "$BODY_FILE" -w '%{http_code}')
    got=$(cat "$BODY_FILE" | DIALECT="$dialect" python3 -c '
import json, os, sys
dialect = os.environ["DIALECT"]
try:
    d = json.load(sys.stdin)
except Exception:
    print("badjson"); raise SystemExit
u = d.get("usage") or {}
# The dialects name the input tokens differently.
key = "prompt_tokens" if dialect == "openai" else "input_tokens"
has_content = bool(d.get("content")) or bool(d.get("choices"))
# The reasoning belongs in its own channel, not in front of the answer:
# an answer that starts with the reasoning is not an answer.
leaked = ""
if dialect == "openai":
    msg = (d.get("choices") or [{}])[0].get("message", {})
    reasoning = msg.get("reasoning_content")
    answer = msg.get("content") or ""
    if isinstance(reasoning, str) and reasoning and reasoning in answer:
        leaked = "leaked reasoning"
else:
    blocks = d.get("content") or []
    thinking = "".join(b.get("thinking", "") for b in blocks if b.get("type") == "thinking")
    answer = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    if thinking and thinking in answer:
        leaked = "leaked reasoning"
print("ok" if has_content and u.get(key, 0) > 0 and not leaked else (leaked or "bad"))
' 2>/dev/null)
    report "$group/$model $dialect non-stream" "ok" "$got"
    # The status line matters as much as the body: a good body under a wrong
    # status is a failure that a body-only check misses.
    report "$group/$model $dialect non-stream status" "2xx" "$(status_class "$status")"

    body="${body/\"stream\":false/\"stream\":true}"
    status=$(curl -s --noproxy '*' -m $TIMEOUT -N -X POST "$BASE/$group/$path" \
      -H 'content-type: application/json' -H 'x-api-key: public' \
      -H 'anthropic-version: 2023-06-01' -d "$body" \
      -o "$BODY_FILE" -w '%{http_code}')
    curl_code=$?
    got=$(cat "$BODY_FILE" | DIALECT="$dialect" python3 -c '
import json, os, sys
dialect = os.environ["DIALECT"]
frames = [l[6:].strip() for l in sys.stdin if l.startswith("data: ")]
key = "prompt_tokens" if dialect == "openai" else "input_tokens"
usage = None
bad = False
for f in frames:
    if f == "[DONE]":
        continue
    try:
        j = json.loads(f)
    except Exception:
        bad = True
        break
    if j.get("usage"):
        usage = j["usage"]
if bad:
    print("badframe")
elif usage and usage.get(key, 0) > 0:
    print("ok")
else:
    print("bad")
' 2>/dev/null)
    # A response that never ends is a failure too: the client would wait for a
    # connection that never closes.
    if [ "$curl_code" -ne 0 ]; then
      report "$group/$model $dialect stream" "ok" "curl exited $curl_code"
      continue
    fi
    report "$group/$model $dialect stream" "ok" "$got"
    report "$group/$model $dialect stream status" "2xx" "$(status_class "$status")"
  done
done

# The tool call: the model asks for a tool and the answer comes back.
out=$(curl -s --noproxy '*' -m $TIMEOUT -X POST "$BASE/workbuddy-cn/v1/messages" \
  -H 'content-type: application/json' -H 'x-api-key: public' \
  -d '{"model":"hy3","max_tokens":128,"tools":[{"name":"get_weather","description":"the weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"messages":[{"role":"user","content":"weather in Beijing?"}]}')
got=$(printf '%s' "$out" | python3 -c '
import json,sys
d = json.load(sys.stdin)
kinds = [c.get("type") for c in d.get("content") or []]
print("ok" if "tool_use" in kinds else "bad")
' 2>/dev/null)
report "workbuddy tool_use" "ok" "$got"

# A model that does not exist is refused with a clear message.
out=$(curl -s --noproxy '*' -m 20 -X POST "$BASE/qoder-cn/v1/messages" \
  -H 'content-type: application/json' -H 'x-api-key: public' \
  -d '{"model":"no-such-model","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}')
got=$(printf '%s' "$out" | python3 -c '
import json,sys
d = json.load(sys.stdin)
print("ok" if d.get("error", {}).get("message", "").startswith("unknown model") else "bad")
' 2>/dev/null)
report "unknown model refused" "ok" "$got"

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
