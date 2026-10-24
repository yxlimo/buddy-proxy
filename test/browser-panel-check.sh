#!/usr/bin/env bash
# test/browser-panel-check.sh — 面板在真浏览器里过一遍。
#
#   test/browser-panel-check.sh <base-url> <admin-token>
#
# 用 agent-browser（Chromium）开面板：令牌闸门、六个页面、配置页的 tab、
# 深链接、控制台有没有报错。网关那边上游全关，不花 token。
set -uo pipefail

BASE="${1:?usage: browser-panel-check.sh <base-url> <admin-token>}"
BASE="${BASE%/}"
TOKEN="${2:?usage: browser-panel-check.sh <base-url> <admin-token>}"
SESSION="${BROWSER_SESSION:-e2e-panel-check}"

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

# 一段 JS，输出一个字符串（agent-browser 把它打印成一个 JSON 字符串）。
js() {
  ab eval --stdin 2>/dev/null | tail -1
}

# 从上面那个字符串里取一个字段：jq_get 'd["tabs"][0]'
jq_get() {
  python3 -c 'import json,sys; d=json.load(sys.stdin); d=json.loads(d) if isinstance(d,str) and d.startswith("{") else d; print(eval(sys.argv[1], {"d": d}))' "$1"
}

# 控制台与页面错误的条数。
console_count() { ab console 2>/dev/null | grep -c . ; }
error_count() { ab errors 2>/dev/null | grep -c . ; }

echo ""
echo "面板的浏览器测试（$BASE）"

# ── 令牌闸门 ────────────────────────────────────────────────────────────
ab open "$BASE/admin/" > /dev/null 2>&1
ab wait --text "输入面板令牌" > /dev/null 2>&1

GATE=$(js <<'EOF'
(() => {
  const url = window.location.href;
  return JSON.stringify({
    hasInput: Boolean(document.querySelector('#admin-token')),
    urlHasToken: url.toLowerCase().includes('token='),
    hash: window.location.hash,
    title: document.title,
  });
})()
EOF
)
check "令牌闸门在" "$(echo "$GATE" | jq_get 'd["hasInput"]')" "True"
check "URL 里没有令牌" "$(echo "$GATE" | jq_get 'd["urlHasToken"]')" "False"
check "令牌闸门没有控制台报错" "$(console_count)" "0"
check "令牌闸门没有页面错误" "$(error_count)" "0"

# ── 用令牌进面板 ────────────────────────────────────────────────────────
ab fill "#admin-token" "$TOKEN" > /dev/null 2>&1
ab find role button click --name "进入面板" > /dev/null 2>&1
ab wait --text "网关现在的状态" > /dev/null 2>&1

IN=$(js <<'EOF'
(() => {
  const url = window.location.href;
  return JSON.stringify({
    url: url,
    urlHasToken: url.toLowerCase().includes('token='),
    stored: Boolean(window.localStorage.getItem('buddy.admin.token')),
    hasNav: Array.from(document.querySelectorAll('a')).some((a) => a.textContent.trim() === '配置'),
  });
})()
EOF
)
check "令牌对的时候进得去面板" "$(echo "$IN" | jq_get 'd["hasNav"]')" "True"
check "进面板之后令牌存进了 localStorage" "$(echo "$IN" | jq_get 'd["stored"]')" "True"
check "URL 里还是没有令牌" "$(echo "$IN" | jq_get 'd["urlHasToken"]')" "False"

# ── 页面 ────────────────────────────────────────────────────────────────
# 每一页都是整页加载（等于顺带测了深链接）。
check_page() {
  local path="$1" heading="$2" name="$3"
  ab console --clear > /dev/null 2>&1
  ab errors --clear > /dev/null 2>&1
  ab open "$BASE$path" > /dev/null 2>&1
  ab wait --text "$heading" > /dev/null 2>&1
  local got
  got=$(js <<EOF
(() => {
  const h1 = document.querySelector('h1');
  return JSON.stringify({
    heading: h1 ? h1.textContent.trim() : '',
    url: window.location.pathname,
  });
})()
EOF
)
  check "$name 打开" "$(echo "$got" | jq_get 'd["heading"]')" "$heading"
  check "$name 深链接的路径没变" "$(echo "$got" | jq_get 'd["url"]')" "$path"
  check "$name 没有控制台报错" "$(console_count)" "0"
  check "$name 没有页面错误" "$(error_count)" "0"
}

check_page "/admin/" "总览" "总览页"
check_page "/admin/upstreams" "上游" "上游页"
check_page "/admin/config" "配置" "配置页"
# 账号与凭据那一页并进了 Provider 页：账号与凭据在展开的行里。
check_page "/admin/balance" "余额" "余额页"
check_page "/admin/usage" "用量" "用量页"
check_page "/admin/models" "主路由模型" "主路由模型页"

# ── 配置页的 tab ────────────────────────────────────────────────────────
ab open "$BASE/admin/config" > /dev/null 2>&1
ab wait --text "配置" > /dev/null 2>&1

TABS=$(js <<'EOF'
(() => {
  const triggers = Array.from(document.querySelectorAll('[role="tab"]'));
  const active = document.querySelector('[role="tab"][data-state="active"]');
  return JSON.stringify({
    tabs: triggers.map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
    active: active ? active.textContent.replace(/\s+/g, ' ').trim() : '',
  });
})()
EOF
)
check "配置页是 tab 布局" "$(echo "$TABS" | jq_get 'len(d["tabs"]) > 0')" "True"
check "默认停在「常规」" "$(echo "$TABS" | jq_get 'd["active"].startswith("常规")')" "True"
check "第一个 tab 是常规" "$(echo "$TABS" | jq_get 'd["tabs"][0].startswith("常规")')" "True"

ITEMS=$(js <<'EOF'
(() => {
  const rows = Array.from(document.querySelectorAll('table tbody tr'));
  const keys = rows.map((r) => {
    const m = r.querySelector('.font-mono');
    return m ? m.textContent.trim() : '';
  }).filter(Boolean);
  const internal = ['QODER_GLOBAL_INFER_BASE', 'QODER_POLL_INTERVAL_MS', 'HEALTH_CACHE_MS',
    'ROUTER_PORT', 'MINIMAX_API_BASE', 'QODER_POLL_TIMEOUT_MS'];
  return JSON.stringify({
    rows: rows.length,
    keys: keys,
    internalVisible: internal.filter((k) => keys.includes(k)),
  });
})()
EOF
)
check "常规这一组有几项" "$(echo "$ITEMS" | jq_get 'd["rows"] > 0')" "True"
check "内部设置看不见" "$(echo "$ITEMS" | jq_get 'd["internalVisible"]')" "[]"

# 每个 tab 都点一遍，数一下总共几项、每一组有几项，顺便看每一组里有没有
# 内部的设置。
# （用真的鼠标点：Radix 的 tab 认的是按下事件，JS 的 click() 不算。）
TOTAL_TABS=$(echo "$TABS" | jq_get 'len(d["tabs"])')
TOTAL_ITEMS=0
KEYS_FILE="$(mktemp)"
for i in $(seq 1 "$TOTAL_TABS"); do
  ab click "[role='tablist'] > button:nth-child($i)" > /dev/null 2>&1
  sleep 0.6
  n=$(js <<'EOF'
(() => String(Array.from(document.querySelectorAll('table tbody tr')).filter((r) => r.offsetParent !== null).length))()
EOF
)
  n="${n//\"/}"
  TOTAL_ITEMS=$((TOTAL_ITEMS + n))
  js <<'EOF' >> "$KEYS_FILE"
(() => JSON.stringify(Array.from(document.querySelectorAll('table tbody tr')).filter((r) => r.offsetParent !== null).map((r) => { const m = r.querySelector('.font-mono'); return m ? m.textContent.trim() : ''; }).filter(Boolean)))()
EOF
done
check "所有 tab 加起来只有 7 项" "$TOTAL_ITEMS" "7"

# 内部的设置：逐组看过一遍，一个都不该在。
READ_KEYS=$(python3 - "$KEYS_FILE" <<'PY'
import json, sys
keys = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        line = json.loads(line)   # agent-browser 打印的是一层 JSON 字符串
    except Exception:
        pass
    try:
        keys.extend(json.loads(line))
    except Exception:
        pass
internal = {"QODER_GLOBAL_INFER_BASE", "QODER_POLL_INTERVAL_MS", "QODER_POLL_TIMEOUT_MS",
            "HEALTH_CACHE_MS", "ROUTER_PORT", "MINIMAX_API_BASE", "MINIMAX_WATCH_MS"}
print("internal=" + ",".join(sorted(set(keys) & internal)))
print("keys=" + ",".join(sorted(set(keys))))
PY
)
check "每一组里都没有内部的设置" "$(echo "$READ_KEYS" | grep '^internal=' | cut -d= -f2-)" ""
check "看过的键就是那 7 个" "$(echo "$READ_KEYS" | grep '^keys=' | cut -d= -f2-)" "ADMIN_CORS_ORIGINS,MINIMAX_CODE,QODER_CN,QODER_GLOBAL,REQUIRE_API_KEY,TOKENRHYTHM,WORKBUDDY_CN"

# 每一组的项数：tab 上的标签自己写着几项。
LABEL_SUM=$(echo "$TABS" | jq_get 'sum(int(t.split("(")[-1].rstrip(")")) for t in d["tabs"])')
check "tab 标签上的项数加起来是 7" "$LABEL_SUM" "7"

# ── 深链接刷新 ──────────────────────────────────────────────────────────
ab open "$BASE/admin/models" > /dev/null 2>&1
sleep 2
ab open "$BASE/admin/models" > /dev/null 2>&1
sleep 2
RELOAD=$(js <<'EOF'
(() => JSON.stringify({
  heading: document.querySelector('h1')?.textContent?.trim() ?? '',
  path: window.location.pathname,
}))()
EOF
)
check "深链接刷新之后还是那一页" "$(echo "$RELOAD" | jq_get 'd["heading"]')" "主路由模型"
check "深链接刷新之后路径没变" "$(echo "$RELOAD" | jq_get 'd["path"]')" "/admin/models"

# ── 静态托管 ────────────────────────────────────────────────────────────
ASSET=$(curl -s "$BASE/admin/" | grep -oE '/admin/assets/[^"]+\.js' | head -1)
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$ASSET")
check "静态资源答得上来" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/assets/does-not-exist.js")
check "不存在的资源是 404" "$code" "404"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")
check "/admin 跳到 /admin/" "$code" "302"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/config")
check "深链接也是 200" "$code" "200"

# ── 令牌闸门：清掉令牌就回到闸门 ────────────────────────────────────────
ab eval --stdin > /dev/null 2>&1 <<'EOF'
(() => { window.localStorage.removeItem('buddy.admin.token'); return 'ok'; })()
EOF
ab open "$BASE/admin/config" > /dev/null 2>&1
ab wait --text "输入面板令牌" > /dev/null 2>&1
GATE2=$(js <<'EOF'
(() => JSON.stringify({ hasInput: Boolean(document.querySelector('#admin-token')) }))()
EOF
)
check "令牌没了就回到闸门" "$(echo "$GATE2" | jq_get 'd["hasInput"]')" "True"

echo ""
echo "pass=$PASS fail=$FAIL"
if [ ${#PROBLEMS[@]} -gt 0 ]; then
  echo ""
  echo "查出来的问题："
  for p in "${PROBLEMS[@]}"; do echo "  - $p"; done
fi
exit $((FAIL == 0 ? 0 : 1))
