#!/usr/bin/env bash
# test/panel-e2e-app.sh — 给面板 e2e 套件起一个网关实例，跑完自己收干净。
#
# 由 `e2e.config.ts` 的 `app.command` 调起（参数与环境都在那儿给），e2e 负责
# 起和停。做三件事：
#
#   1. 每次运行新建一个数据目录（`mktemp -d`），把路径写进 marker 文件，
#      测试与凭据那一侧靠它找 `admin-token`。**绝不**落回 `~/.buddy-proxy`
#      或 NAS 上的库：那里的会话两边轮流用会废掉。
#   2. 网关起成后台子进程，面板由它从 `$PANEL_DIST` 托管在 /admin/ 下。
#   3. 退出时（正常结束、Ctrl-C、被 TERM）把子进程停掉、把数据目录和 marker
#      删掉：一轮跑完 `/tmp` 里不该多出东西来。「启动前顺手删掉一天以前的遗留
#      目录」只是给「上一轮被硬杀、谁都没来得及收尾」这种情况兜底。
#
# 上游一律关着（`PERIODIC_ENABLED=false` 由配置给）：这些测试不花 token。
set -euo pipefail

: "${DATA_DIR_MARKER:?需要 DATA_DIR_MARKER（e2e.config.ts 给的）}"
: "${ROUTER_PORT:=6799}"

# 兜底：上一轮被 kill -9、或者框架直接杀了整组时，这个脚本没机会收尾，一轮一个
# 目录。两小时以前的才删 —— 正常跑一轮两分钟，两小时还留着的必然是没人管的；
# 正在跑的那份（刚建的后代、mtime 是新的）不动。
find /tmp -maxdepth 1 -name 'buddy-panel-e2e.*' -type d -mmin +120 -exec rm -rf {} + 2>/dev/null || true
# 浏览器 profile 落在数据目录里（见 `e2e.config.ts` 的 `systemChromium`），数据目录
# 没了 profile 也没了；这一句是给早先那版（profile 直接建在 /tmp）留下的东西。
find /tmp -maxdepth 1 -name 'e2e-chromium.*' -type d -mtime +0 -exec rm -rf {} + 2>/dev/null || true

DATA_DIR="$(mktemp -d /tmp/buddy-panel-e2e.XXXXXX)"
MARKER_DIR="$(dirname "$DATA_DIR_MARKER")"
mkdir -p "$MARKER_DIR"
printf '%s\n' "$DATA_DIR" > "$DATA_DIR_MARKER"

echo "  面板 e2e 的数据目录：$DATA_DIR"

export BUDDY_DATA_DIR="$DATA_DIR"
export ROUTER_PORT

# ── 上游地址：**这一批用例走到的**上游指到本机的假上游 ────────────────────
#
# 面板 e2e 里有几件事只能由上游回答：排队（Qoder 把模型停进队列）、登录的
# 「发起」那一步（设备码与授权链接）、开放平台的模型目录、以及推理请求本身
# （WorkBuddy 与 MiniMax Code 那两条）。答复都是录下来的实录
# （`test/fixtures/panel-e2e/`），由 `tests/panel-upstream.ts` 在
# 127.0.0.1:6820 上按路径回放；路径对不上的，它答 404。
#
# 范围说清楚，别把这句话读成「整套 e2e 一条真请求都没有」：**只有下面这几格
# 被改指**。别家厂商平台（TokenRhythm / 书生·端砚 / SenseNova / 七牛云 / 讯飞）
# 的地址是数据 —— 建平台那一行填的 base_url —— 这一批用例不触发它们。签到那条
# 更是**没有环境变量可覆盖**：`lib/minimax/checkin.ts` 的 `PUBLIC_GATEWAYS`
# 把 `https://agent.minimaxi.com`（全球区 `agent.minimax.io`）写死在代码里，
# 所以签到不在这套 e2e 的范围里 —— 面板上「现在签到」这类动作不要在这里点。
#
# 这些设置都在网关**启动时读一次**（`lib/config.ts`；`MINIMAX_BASE_URL` 是
# `lib/minimax/transport.ts` 的模块级常量，`WORKBUDDY_CHAT_BASE` 是第一次用到
# 时读、之后缓存），所以只能在这儿给：测试进程起来的时候网关已经在跑了。
# 注释里是原来的值 —— 漏掉一格，那就是一条发往真上游的请求。
PANEL_E2E_UPSTREAM_PORT="${PANEL_E2E_UPSTREAM_PORT:-6820}"
UPSTREAM="http://127.0.0.1:${PANEL_E2E_UPSTREAM_PORT}"

# MiniMax Code：设备流的 origin（原值 https://account.minimax.cn），
# 以及额度那几个查询的基址（原值 https://api.minimax.cn / https://agent.minimax.cn），
# 和推理那一条（Anthropic 方言，原值 https://agent.minimax.cn/mavis/api/v1/llm/v1；
# 全球区是 https://agent.minimax.io/…）。读推理基址的是
# `lib/minimax/transport.ts:29-34` 的 `BASE_URL` / `UPSTREAM`。
export MINIMAX_OAUTH_ORIGIN="$UPSTREAM"
export MINIMAX_API_BASE="$UPSTREAM"
export MINIMAX_BASE_URL="$UPSTREAM"

# WorkBuddy（中国区）：登录的基址与 origin（原值 https://www.workbuddy.cn / https://www.codebuddy.cn）。
export WORKBUDDY_CN_BASE="$UPSTREAM"
export WORKBUDDY_CN_ORIGIN="$UPSTREAM"

# WorkBuddy：账号自己那套 API 的基址 —— 推理请求（`lib/workbuddy/auth.ts` 的
# `chatBase`，被 `lib/workbuddy/transport.ts:219` 用去发推理）与权益、积分
# （`lib/workbuddy/api.ts:12` 的 `apiBase`）都读它。原值不是一格设置：是账号自己的
# 域名，中国区 https://www.workbuddy.cn、全球区 https://www.workbuddy.ai /
# https://www.codebuddy.ai —— 后两个这一批走不到。
export WORKBUDDY_CHAT_BASE="$UPSTREAM"

# ZCode（原值 https://zcode.z.ai）。
export ZCODE_BASE_URL="$UPSTREAM"

# Qoder（中国区）：登录轮询与额度（原值 https://openapi.qoder.com.cn），
# 推理那条老协议（原值 https://gateway.qoder.com.cn）。
export QODER_CN_OPENAPI_BASE="$UPSTREAM"
export QODER_CN_INFER_BASE="$UPSTREAM"

APP_PID=""
WATCHER_PID=""

# 收尾：停子进程（等它自己退，等不到就硬杀），再删数据目录与 marker。
# marker 那条路径 `.e2e/tmp/panel-data-dir` 是 `tests/panel.ts` 写死的，所以只
# 用 `rmdir` 收空目录 —— 空不了就留着，别把 `.e2e/report.json` 一起带走。
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  # 先摘掉看门狗：否则它会在脚本退掉之后继续轮询，万一 pid 被别的进程复用
  # 还会往无关进程上发 TERM。
  if [ -n "$WATCHER_PID" ]; then
    kill "$WATCHER_PID" 2>/dev/null || true
  fi
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    # 网关把 SIGTERM 当「该收了」：关监听、放下手上的请求再退（最多 20 秒）。
    # 正常情况一瞬就退了，这里给 5 秒；等不到就硬杀。
    kill -TERM "$APP_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -KILL "$APP_PID" 2>/dev/null || true
    fi
    wait "$APP_PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR"
  rm -f "$DATA_DIR_MARKER"
  rmdir "$MARKER_DIR" 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node --experimental-strip-types router-proxy.ts &
APP_PID=$!

# 看门狗：e2e 中途被硬杀（SIGKILL 掉整个 worker，来不及给任何信号）时，网关会
# 变成孤儿一直活着、数据目录也跟着留下。所以这条脚本的命跟着把它拉起来的进程走：
# 监工一没，就按 Ctrl-C 处理（发自己 TERM，走下面的 trap）。
#
# 判「没了」看 PPID 而不看 `kill -0`：父进程死了但还没被回收时是 zombie，
# `kill -0` 对它依然返回 0，看门狗会一直等下去（这个真踩到过）。而父进程一退出，
# 子进程立刻被 subreaper（这里是跑测试的那个 agent 进程）或 init 收养，PPID 就变
# 了 —— 这个信号不受回收时机影响。
SUPERVISOR_PID=$PPID
(
  while [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')" = "$SUPERVISOR_PID" ]; do
    sleep 0.5
  done
  kill -TERM "$$" 2>/dev/null || true
) &
WATCHER_PID=$!

# 子进程的退出码原样返回：e2e 靠它判断 app 有没有起来（非 0 就是没起来）。
# `set -e` 下 `wait` 直接把脚本带走，那样 EXIT trap 里的 `$?` 就不可信了。
status=0
wait "$APP_PID" || status=$?
echo "  网关退出了（code=${status}），收尾"
exit "$status"
