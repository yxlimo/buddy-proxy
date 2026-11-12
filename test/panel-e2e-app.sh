#!/usr/bin/env bash
# test/panel-e2e-app.sh — 给面板 e2e 套件起一个网关实例。
#
# 由 `e2e.config.ts` 的 `app.command` 调起（参数与环境都在那儿给），e2e 负责
# 起和停。做两件事：
#
#   1. 每次运行新建一个数据目录（`mktemp -d`），把路径写进 marker 文件，
#      测试与凭据那一侧靠它找 `admin-token`。**绝不**落回 `~/.buddy-proxy`
#      或 NAS 上的库：那里的会话两边轮流用会废掉。
#   2. exec 真网关。面板由它从 `$PANEL_DIST` 托管在 /admin/ 下。
#
# 上游一律关着（`PERIODIC_ENABLED=false` 由配置给）：这些测试不花 token。
set -euo pipefail

: "${DATA_DIR_MARKER:?需要 DATA_DIR_MARKER（e2e.config.ts 给的）}"
: "${ROUTER_PORT:=6799}"

# 这个脚本会被 exec，自己没机会清理，所以顺手把上一轮留下的目录删掉：e2e 起了
# 进程就杀掉时（Ctrl-C、超时）没人收尾，一轮一个目录，攒着会占满 /tmp。只删一天
# 以前的，正在跑的那份不动。
find /tmp -maxdepth 1 -name 'buddy-panel-e2e.*' -type d -mtime +0 -exec rm -rf {} + 2>/dev/null || true

DATA_DIR="$(mktemp -d /tmp/buddy-panel-e2e.XXXXXX)"
mkdir -p "$(dirname "$DATA_DIR_MARKER")"
printf '%s\n' "$DATA_DIR" > "$DATA_DIR_MARKER"

echo "  面板 e2e 的数据目录：$DATA_DIR"

export BUDDY_DATA_DIR="$DATA_DIR"
export ROUTER_PORT

exec node --experimental-strip-types router-proxy.ts
