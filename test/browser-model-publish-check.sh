#!/usr/bin/env bash
# test/browser-model-publish-check.sh — 在面板上加一个主路由模型，客户端用它发请求。
#
#   test/browser-model-publish-check.sh
#
# 用户自己说的那条链路，一个字不改：
#
#   面板上加一个主路由模型 → 发布出去 → 客户端用它发请求 → 请求真的走到那个
#   上游 → 回来的模型名是客户端问的那个对外 id。
#
# 上游是假的上游（test/fake-qoder-upstream.ts），不碰任何平台，不花 token。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-6797}"
FAKE_PORT="${FAKE_PORT:-6798}"
DATA_DIR="${DATA_DIR:-/tmp/opencode/e2e-browser-model}"
SESSION="${BROWSER_SESSION:-e2e-model-check}"
BASE="http://127.0.0.1:$PORT"
MODEL_ID="e2e-published"

PASS=0
FAIL=0
PROBLEMS=()

ab() { agent-browser --session "$SESSION" "$@"; }

check() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    printf '  ok   %-46s %s\n' "$name" "$got"
  else
    FAIL=$((FAIL + 1))
    PROBLEMS+=("$name (want=$want got=$got)")
    printf '  FAIL %-46s want=%s got=%s\n' "$name" "$want" "$got"
  fi
}

js() { ab eval --stdin 2>/dev/null | tail -1; }

jq_get() {
  python3 -c 'import json,sys; d=json.load(sys.stdin); d=json.loads(d) if isinstance(d,str) and d.startswith("{") else d; print(eval(sys.argv[1], {"d": d}))' "$1"
}

# 跑一段 JS，再在它的结果上算一个表达式。
jsq() {
  local expr="$1"
  js | jq_get "$expr"
}

# ── 假的上游与网关 ──────────────────────────────────────────────────────
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

node --experimental-strip-types test/fake-qoder-upstream.ts "$FAKE_PORT" > "$DATA_DIR/fake.log" 2>&1 &
FAKE_PID=$!
sleep 1.5
# 假上游要真的起来了：端口被占的话请求会打到别人的服务上。
if ! curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$FAKE_PORT/ping" 2>/dev/null; then
  if ! grep -q "fake qoder upstream on" "$DATA_DIR/fake.log"; then
    echo "假上游没起来（端口 $FAKE_PORT 可能被占了）："
    cat "$DATA_DIR/fake.log"
    exit 1
  fi
fi

# Qoder 的会话种进测试自己的数据库：没有会话，网关就不发请求（会走设备流
# 去真的登录）。
BUDDY_DATA_DIR="$DATA_DIR" node --experimental-strip-types test/aggregate-setup.ts seed > /dev/null 2>&1

FAKE="http://127.0.0.1:$FAKE_PORT"
BUDDY_DATA_DIR="$DATA_DIR" ROUTER_PORT="$PORT" BENEFITS_DISABLED=1 \
  QODER_GLOBAL=true QODER_CN= MINIMAX_CODE= WORKBUDDY_CN= TOKENRHYTHM= \
  QODER_GLOBAL_INFER_BASE="$FAKE/qoder-global" \
  QODER_GLOBAL_OPENAPI_BASE="$FAKE/openapi-global" \
  QODER_GLOBAL_LEGACY_BASE="$FAKE/qoder-global-legacy" \
  node router-proxy.ts > "$DATA_DIR/router.log" 2>&1 &
ROUTER_PID=$!

cleanup() {
  kill $ROUTER_PID $FAKE_PID 2>/dev/null
  wait $ROUTER_PID $FAKE_PID 2>/dev/null
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -fsS "$BASE/health" > /dev/null 2>&1 && break
  sleep 0.25
done

TOKEN="$(cat "$DATA_DIR/admin-token" 2>/dev/null)"
if [ -z "$TOKEN" ]; then
  echo "网关没起来："
  tail -5 "$DATA_DIR/router.log"
  exit 1
fi

echo ""
echo "面板发布主路由模型的浏览器测试（$BASE）"

# ── 进面板的主路由模型页 ────────────────────────────────────────────────
ab open "$BASE/admin/models" > /dev/null 2>&1
sleep 2
ab fill "#admin-token" "$TOKEN" > /dev/null 2>&1
ab find role button click --name "进入面板" > /dev/null 2>&1
sleep 2
check "主路由模型页打开了" "$(js <<'EOF'
(() => (document.querySelector('h1')?.textContent ?? ''))()
EOF
)" "\"主路由模型\""

# ── 新建一个 ────────────────────────────────────────────────────────────
ab find role button click --name "新建" > /dev/null 2>&1
sleep 1.5
check "新建对话框开了" "$(jsq 'd["open"]' <<'EOF'
(() => {
  const dlg = document.querySelector('[role="dialog"]');
  return JSON.stringify({ open: Boolean(dlg), title: dlg ? (dlg.querySelector('h2')?.textContent ?? '') : '' });
})()
EOF
)" "True"

ab fill "#model-id" "$MODEL_ID" > /dev/null 2>&1
ab fill "#model-name" "E2E 发布" > /dev/null 2>&1

# 切到「上游目标」那一页（真的按下：Radix 的 tab 认 mousedown）。
ab click "[role='dialog'] [role='tablist'] > button:nth-child(2)" > /dev/null 2>&1
sleep 1
check "切到上游目标那页了" "$(jsq 'd["tab"].startswith("上游目标")' <<'EOF'
(() => {
  const active = document.querySelector('[role="dialog"] [role="tab"][data-state="active"]');
  return JSON.stringify({ tab: active ? active.textContent.replace(/\s+/g, ' ').trim() : '' });
})()
EOF
)" "True"

ab fill "#target-group-0" "qoder" > /dev/null 2>&1
sleep 1.5

# 选上游模型：目录里有就下拉选。
ab click "#target-model-0" > /dev/null 2>&1
sleep 1
ab find role option click --name "glm-5.3" > /dev/null 2>&1
sleep 1
PICKED=$(js <<'EOF'
(() => {
  const btn = document.querySelector('#target-model-0');
  return JSON.stringify({ text: btn ? btn.textContent.trim() : '' });
})()
EOF
)
check "选上了上游模型 glm-5.3" "$(echo "$PICKED" | jq_get 'd["text"]')" "glm-5.3"

ab fill "#target-weight-0" "10" > /dev/null 2>&1

ab find role button click --name "保存" > /dev/null 2>&1
sleep 2
SAVED=$(js <<'EOF'
(() => {
  const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.innerText.replace(/\s+/g, ' ').trim());
  const rows = Array.from(document.querySelectorAll('table tbody tr')).map((r) => r.innerText.replace(/\s+/g, ' ').trim());
  return JSON.stringify({ toasts: toasts, rows: rows, dialogOpen: Boolean(document.querySelector('[role="dialog"]')) });
})()
EOF
)
check "保存的提示是中文" "$(echo "$SAVED" | jq_get 'any("已经生效" in t for t in d["toasts"])')" "True"
check "对话框关了" "$(echo "$SAVED" | jq_get 'd["dialogOpen"]')" "False"
check "列表里有这个模型" "$(echo "$SAVED" | jq_get 'any("e2e-published" in r for r in d["rows"])')" "True"

# ── 客户端用它发请求 ────────────────────────────────────────────────────
LIST=$(curl -s "$BASE/v1/models")
check "客户端的目录里有它" "$(echo "$LIST" | python3 -c 'import json,sys; print(any(m["id"]=="e2e-published" for m in json.load(sys.stdin)["data"]))')" "True"

BEFORE=$(curl -s "$DATA_DIR/fake.log" | wc -l)
ANSWER=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"e2e-published","messages":[{"role":"user","content":"say ok"}]}')
echo "    （答复：${ANSWER:0:300}）"
check "客户端用它发请求能通" "$(echo "$ANSWER" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("choices",[{"message":{"content":"?"}}])[0]["message"]["content"])')" "ok"
check "回来的 model 是客户端问的那个对外 id" "$(echo "$ANSWER" | python3 -c 'import json,sys; print(json.load(sys.stdin)["model"])')" "$MODEL_ID"
check "回来的不是上游内部的名字" "$(echo "$ANSWER" | python3 -c 'import json,sys; m=json.load(sys.stdin)["model"]; print(m in ("gmodel","glm-5.3"))')" "False"

# 假上游确实收到了这个请求。
SAW=$(python3 - <<'PY'
import re
log = open('/tmp/opencode/e2e-browser-model/fake.log').read()
print('ok' if log else 'empty')
PY
)
# 假上游的日志只有启动那行；请求有没有到，看路由器的用量表更实在。
REQUESTS=$(curl -s -X POST "$BASE/buddy.admin.v1.AdminService/ListPublishedModels" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}')
check "面板上这个模型的请求数是 1" "$(echo "$REQUESTS" | python3 -c '
import json,sys
d=json.load(sys.stdin)
m=[x for x in d.get("models",[]) if x["id"]=="e2e-published"]
print(m[0]["targets"][0]["requests"] if m else "no model")
')" "1"

# ── 删掉 ────────────────────────────────────────────────────────────────
ab find role button click --name "删" > /dev/null 2>&1
sleep 1.5
ab find role button click --name "删掉" > /dev/null 2>&1
sleep 2
GONE=$(curl -s "$BASE/v1/models")
check "删掉之后客户端的目录里没有了" "$(echo "$GONE" | python3 -c 'import json,sys; print(any(m["id"]=="e2e-published" for m in json.load(sys.stdin).get("data",[])))')" "False"

echo ""
echo "pass=$PASS fail=$FAIL"
if [ ${#PROBLEMS[@]} -gt 0 ]; then
  echo ""
  echo "查出来的问题："
  for p in "${PROBLEMS[@]}"; do echo "  - $p"; done
fi
exit $((FAIL == 0 ? 0 : 1))
