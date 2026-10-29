#!/usr/bin/env bash
# test/browser-login-check.sh — 登录对话框的四种形态，在真浏览器里。
#
#   test/browser-login-check.sh
#
# 起一个假的上游（只答登录那几条路，什么都不出机器），起网关（上游全关），
# 再用 agent-browser 点开对话框：
#
#   device   （MiniMax）链接 + 大字码 + 倒计时 + 3 秒轮询
#   browser  （WorkBuddy）只有链接
#   password （SenseNova）表单 + 提交中禁用
#   token    （intern-ai）SSO 链接 + 人机校验说明
#   失败     （Qoder）机器码不该出现在面板上
#   刷新     刷新之后靠 hash 里的 login_id 接得上
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAKE_PORT="${FAKE_PORT:-6793}"
DATA_DIR="${DATA_DIR:-/tmp/opencode/e2e-browser-login}"
SESSION="${BROWSER_SESSION:-e2e-login-check}"
# 网关的端口由 test/serve.ts 挑（共享 helper），起来之后才知道基址。
BASE=""

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

# 点某个账号那一行的「登录」。
# 账号与凭据在 Provider 页展开的行里：先把那个 Provider 的行展开，再找
# 「登录」按钮。
click_login() {
  local label="$1"
  ab eval --stdin > /dev/null 2>&1 <<EOF
(() => {
  const rows = Array.from(document.querySelectorAll('table tbody tr'));
  const row = rows.find((r) => r.textContent.includes($(printf '%s' "$label" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')));
  if (!row) return 'no row';
  // 展开它：点那一行（或者点展开箭头）。
  const toggle = row.querySelector('button[aria-expanded]');
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
    toggle.click();
  } else if (!row.querySelector('button[aria-expanded]')) {
    row.click();
  }
  return 'expanded';
})()
EOF
  sleep 1
  ab eval --stdin > /dev/null 2>&1 <<EOF
(() => {
  const rows = Array.from(document.querySelectorAll('table tbody tr'));
  const row = rows.find((r) => r.textContent.includes($(printf '%s' "$label" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')));
  if (!row) return 'no row';
  const btn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === '登录');
  if (!btn) return 'no button';
  btn.click();
  return 'clicked';
})()
EOF
}

close_dialog() {
  ab eval --stdin > /dev/null 2>&1 <<'EOF'
(() => {
  const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((x) => x.textContent.trim() === '关闭');
  if (b) b.click();
  return 'ok';
})()
EOF
  sleep 1
}

# ── 假的上游与网关 ──────────────────────────────────────────────────────
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

node --experimental-strip-types test/fake-login-upstream.ts "$FAKE_PORT" > "$DATA_DIR/fake.log" 2>&1 &
FAKE_PID=$!
sleep 1.5

FAKE="http://127.0.0.1:$FAKE_PORT"

# 网关交给 test/serve.ts：端口由共享 helper 挑，假上游的地址用 --env 逐个传。
READY="$(mktemp -d)/ready.json"
node --experimental-strip-types test/serve.ts --data-dir "$DATA_DIR" --ready-file "$READY" \
  --env "MINIMAX_OAUTH_ORIGIN=$FAKE" \
  --env "WORKBUDDY_CN_BASE=$FAKE/workbuddy" \
  --env "QODER_GLOBAL_OPENAPI_BASE=$FAKE/qoder-openapi" \
  --env "SENSENOVA_PLATFORM_BASE=$FAKE/sensenova" \
  --env "SENSENOVA_IAM_BASE=$FAKE/sensenova" \
  --env "INTERN_AI_SSO_BASE=$FAKE/intern-ai" \
  --env "INTERN_AI_SSO_API_BASE=$FAKE/intern-ai" \
  --env "TOKENRHYTHM_API_BASE=$FAKE/tokenrhythm" \
  > "$DATA_DIR/router.log" 2>&1 &
ROUTER_PID=$!

cleanup() {
  kill $ROUTER_PID $FAKE_PID 2>/dev/null
  wait $ROUTER_PID $FAKE_PID 2>/dev/null
}
trap cleanup EXIT

for _ in $(seq 1 120); do
  [ -f "$READY" ] && break
  kill -0 $ROUTER_PID 2>/dev/null || break
  sleep 0.5
done

BASE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["base"])' "$READY" 2>/dev/null)"
TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$READY" 2>/dev/null)"
if [ -z "$TOKEN" ]; then
  echo "网关没起来："
  tail -20 "$DATA_DIR/router.log"
  exit 1
fi

echo ""
echo "登录对话框的浏览器测试（$BASE）"

# ── 进面板 ──────────────────────────────────────────────────────────────
ab open "$BASE/admin/upstreams" > /dev/null 2>&1
sleep 2
ab fill "#admin-token" "$TOKEN" > /dev/null 2>&1
ab find role button click --name "进入面板" > /dev/null 2>&1
sleep 2
H1=$(js <<'EOF'
(() => (document.querySelector('h1')?.textContent ?? ''))()
EOF
)
check "Provider 页打开了" "$(echo "$H1" | jq_get 'd')" "Provider"

# ── device（MiniMax）────────────────────────────────────────────────────
click_login "MiniMax Code"
sleep 3
DEVICE=$(js <<'EOF'
(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return JSON.stringify({ open: false });
  const text = dlg.innerText.replace(/\s+/g, ' ').trim();
  return JSON.stringify({
    open: true,
    link: Array.from(dlg.querySelectorAll('a')).map((a) => a.getAttribute('href')).filter(Boolean),
    hasBigCode: text.includes('大字码'),
    bigCode: /WXYZ-1234/.test(text),
    countdown: /还剩 \d+ 分 \d+ 秒/.test(text),
    waiting: text.includes('正在等你在浏览器里同意'),
    hash: window.location.hash,
  });
})()
EOF
)
check "device：对话框开了" "$(echo "$DEVICE" | jq_get 'd["open"]')" "True"
check "device：有授权链接" "$(echo "$DEVICE" | jq_get 'len(d["link"]) == 1')" "True"
check "device：有大字码" "$(echo "$DEVICE" | jq_get 'd["hasBigCode"] and d["bigCode"]')" "True"
check "device：有倒计时" "$(echo "$DEVICE" | jq_get 'd["countdown"]')" "True"
check "device：写着在等你同意" "$(echo "$DEVICE" | jq_get 'd["waiting"]')" "True"
check "device：login_id 进了 hash" "$(echo "$DEVICE" | jq_get 'd["hash"].startswith("#login=")')" "True"

# 轮询：3 秒一次。
ab network har start > /dev/null 2>&1
sleep 11
ab network har stop "$DATA_DIR/poll.har" > /dev/null 2>&1
POLL=$(python3 - "$DATA_DIR/poll.har" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("0 polls")
    raise SystemExit
times = [e["startedDateTime"] for e in d["log"]["entries"] if "GetLoginStatus" in e["request"]["url"]]
if len(times) < 2:
    print("0 polls")
    raise SystemExit
from datetime import datetime
def t(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))
gaps = [round((t(b) - t(a)).total_seconds(), 1) for a, b in zip(times, times[1:])]
print(f"{len(times)} polls; gaps={gaps}")
PY
)
check "device：3 秒轮询一次" "$(echo "$POLL" | grep -oE 'gaps=\[[^]]*\]' | grep -cE '3\.0')" "1"

# ── 刷新之后接得上 ──────────────────────────────────────────────────────
URL=$(ab get url)
ab open "$URL" > /dev/null 2>&1
sleep 4
AFTER=$(js <<'EOF'
(() => {
  const dlg = document.querySelector('[role="dialog"]');
  return JSON.stringify({
    hash: window.location.hash,
    open: Boolean(dlg),
    hasBigCode: dlg ? dlg.innerText.includes('WXYZ-1234') : false,
  });
})()
EOF
)
check "刷新之后还接得上（hash 里的 login_id）" "$(echo "$AFTER" | jq_get 'd["open"] and d["hasBigCode"]')" "True"

close_dialog

# ── browser（WorkBuddy）─────────────────────────────────────────────────
click_login "WorkBuddy（中国区）"
sleep 3
BROWSER=$(js <<'EOF'
(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return JSON.stringify({ open: false });
  const text = dlg.innerText.replace(/\s+/g, ' ').trim();
  return JSON.stringify({
    open: true,
    links: Array.from(dlg.querySelectorAll('a')).map((a) => a.getAttribute('href')).filter(Boolean),
    hasBigCode: text.includes('大字码'),
    countdown: /还剩 \d+ 分 \d+ 秒/.test(text),
  });
})()
EOF
)
check "browser：对话框开了" "$(echo "$BROWSER" | jq_get 'd["open"]')" "True"
check "browser：只有链接" "$(echo "$BROWSER" | jq_get 'len(d["links"]) == 1')" "True"
check "browser：没有大字码" "$(echo "$BROWSER" | jq_get 'd["hasBigCode"]')" "False"
close_dialog

# ── password（SenseNova）───────────────────────────────────────────────
click_login "SenseNova"
sleep 3
PASSWORD=$(js <<'EOF'
(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return JSON.stringify({ open: false });
  return JSON.stringify({
    open: true,
    user: Boolean(dlg.querySelector('#login-username')),
    pass: Boolean(dlg.querySelector('#login-password')),
    checkbox: Boolean(dlg.querySelector('input[type="checkbox"]')),
    submit: Array.from(dlg.querySelectorAll('button')).some((b) => b.textContent.trim() === '登录'),
  });
})()
EOF
)
check "password：表单出来了" "$(echo "$PASSWORD" | jq_get 'd["open"]')" "True"
check "password：有账号名输入框" "$(echo "$PASSWORD" | jq_get 'd["user"]')" "True"
check "password：有密码输入框" "$(echo "$PASSWORD" | jq_get 'd["pass"]')" "True"
check "password：有记住密码" "$(echo "$PASSWORD" | jq_get 'd["checkbox"]')" "True"
check "password：有登录按钮" "$(echo "$PASSWORD" | jq_get 'd["submit"]')" "True"

ab fill "#login-username" "tester@example.invalid" > /dev/null 2>&1
ab fill "#login-password" "not-a-real-password" > /dev/null 2>&1
SUBMIT=$(js <<'EOF'
(async () => {
  const dlg = document.querySelector('[role="dialog"]');
  const btn = Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent.trim() === '登录');
  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  const again = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === '登录');
  return JSON.stringify({
    disabled: again ? again.disabled : null,
    spinner: again ? again.querySelector('.animate-spin') !== null : false,
  });
})()
EOF
)
check "password：提交中按钮禁用" "$(echo "$SUBMIT" | jq_get 'd["disabled"]')" "True"
check "password：提交中转圈" "$(echo "$SUBMIT" | jq_get 'd["spinner"]')" "True"

sleep 5
TOAST=$(js <<'EOF'
(() => {
  const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.innerText.replace(/\s+/g, ' ').trim());
  return JSON.stringify({
    toasts: toasts,
    chinese: toasts.some((t) => /[\u4e00-\u9fff]/.test(t)),
    machineCode: toasts.some((t) => /upstream_error|Error|error_code/i.test(t)),
  });
})()
EOF
)
check "password：失败有中文提示" "$(echo "$TOAST" | jq_get 'd["chinese"]')" "True"
check "password：提示里没有机器码" "$(echo "$TOAST" | jq_get 'd["machineCode"]')" "False"
close_dialog

# ── token（intern-ai）──────────────────────────────────────────────────
click_login "intern-ai"
sleep 3
TOKENFORM=$(js <<'EOF'
(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return JSON.stringify({ open: false });
  const text = dlg.innerText.replace(/\s+/g, ' ').trim();
  return JSON.stringify({
    open: true,
    links: Array.from(dlg.querySelectorAll('a')).map((a) => a.getAttribute('href')).filter(Boolean),
    sso: text.includes('SSO 登录链接'),
    captcha: text.includes('人机校验'),
    tokenInput: Boolean(dlg.querySelector('#login-token')),
    importButton: Array.from(dlg.querySelectorAll('button')).some((b) => b.textContent.trim() === '导入'),
    site: Boolean(dlg.querySelector('#login-site')),
  });
})()
EOF
)
check "token：对话框开了" "$(echo "$TOKENFORM" | jq_get 'd["open"]')" "True"
check "token：有 SSO 登录链接" "$(echo "$TOKENFORM" | jq_get 'len(d["links"]) == 1')" "True"
check "token：写了人机校验怎么办" "$(echo "$TOKENFORM" | jq_get 'd["captcha"]')" "True"
check "token：有子站选择" "$(echo "$TOKENFORM" | jq_get 'd["site"]')" "True"
check "token：有 uaa-token 输入框" "$(echo "$TOKENFORM" | jq_get 'd["tokenInput"]')" "True"
check "token：有导入按钮" "$(echo "$TOKENFORM" | jq_get 'd["importButton"]')" "True"
close_dialog

# ── 失败（Qoder）：机器码不该露出来 ─────────────────────────────────────
click_login "Qoder（全球区）"
sleep 5
FAILED=$(js <<'EOF'
(() => {
  const dlg = document.querySelector('[role="dialog"]');
  const text = dlg ? dlg.innerText.replace(/\s+/g, ' ').trim() : '';
  return JSON.stringify({
    open: Boolean(dlg),
    text: text,
    chinese: /[\u4e00-\u9fff]/.test(text),
    machineCode: /device poll failed|E_AUTH_REJECTED/.test(text),
  });
})()
EOF
)
check "失败：对话框说了结果" "$(echo "$FAILED" | jq_get 'd["open"]')" "True"
check "失败：有中文" "$(echo "$FAILED" | jq_get 'd["chinese"]')" "True"
check "失败：机器码没有露出来" "$(echo "$FAILED" | jq_get 'd["machineCode"]')" "False"

echo ""
echo "pass=$PASS fail=$FAIL"
if [ ${#PROBLEMS[@]} -gt 0 ]; then
  echo ""
  echo "查出来的问题："
  for p in "${PROBLEMS[@]}"; do echo "  - $p"; done
fi
echo ""
echo "（失败时面板上显示的那句：$(echo "$FAILED" | jq_get 'd["text"]'))"
exit $((FAIL == 0 ? 0 : 1))
