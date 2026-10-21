#!/usr/bin/env bash
# Start the router with its upstreams pointing somewhere else.
#
#   test/run-router.sh <port> <upstream-base>
#
# The upstream base is where the router sends its traffic: the real upstreams
# (empty), the recording proxy, or the mock server. The routes are the same in
# all three cases, so the router does not know the difference.
set -uo pipefail

PORT="${1:?usage: run-router.sh <port> <upstream-base>}"
BASE="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export WORKBUDDY_CN=true QODER_CN=true QODER_GLOBAL=true MINIMAX_CODE=true
export WORKBUDDY_DATA_DIR="${WORKBUDDY_DATA_DIR:-$HOME/.workbuddy-proxy}"
export QODER_DATA_DIR="${QODER_DATA_DIR:-$HOME/.qoder-proxy}"
export ROUTER_PORT="$PORT"

if [ -n "$BASE" ]; then
  export QODER_GLOBAL_INFER_BASE="$BASE/qoder-global"
  export QODER_GLOBAL_LEGACY_BASE="$BASE/qoder-global-legacy"
  export QODER_CN_INFER_BASE="$BASE/qoder-cn"
  export QODER_GLOBAL_OPENAPI_BASE="$BASE/openapi-global"
  export QODER_CN_OPENAPI_BASE="$BASE/openapi-cn"
  export WORKBUDDY_CHAT_BASE="$BASE/workbuddy"
  export MINIMAX_UPSTREAM_URL="$BASE/minimax"
else
  export MINIMAX_UPSTREAM_URL="${MINIMAX_UPSTREAM_URL:-http://192.168.50.4:6448}"
fi

# The benefits would talk to the upstream for nothing during a test.
export BENEFITS_DISABLED=1

# exec, so the process this script starts is the one that gets killed.
exec node router-proxy.ts
