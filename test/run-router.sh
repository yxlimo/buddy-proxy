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
# The relay station is only served when its accounts are configured.
export TOKENRHYTHM="${TOKENRHYTHM:-}"
export WORKBUDDY_DATA_DIR="${WORKBUDDY_DATA_DIR:-$HOME/.workbuddy-proxy}"
export QODER_DATA_DIR="${QODER_DATA_DIR:-$HOME/.qoder-proxy}"
export ROUTER_PORT="$PORT"

# The router holds the MiniMax credential itself, so it needs one — but the
# mock never looks at it. A dummy session keeps the test away from the real
# one and stops the device flow from starting.
export MINIMAX_DATA_DIR="${MINIMAX_DATA_DIR:-/tmp/opencode/test-minimax}"
# The credentials live in the database; the test gets its own.
export BUDDY_DB_PATH="${BUDDY_DB_PATH:-/tmp/opencode/test-buddy.db}"
mkdir -p "$MINIMAX_DATA_DIR"
if [ ! -f "$MINIMAX_DATA_DIR/minimax-session.json" ]; then
  node -e '
const fs = require("fs");
const path = process.argv[1] + "/minimax-session.json";
const now = Date.now();
fs.writeFileSync(path, JSON.stringify({
  schemaVersion: 1, clientId: "mcode-public", audience: "agent-backend",
  scopes: ["agent.default"], region: "cn",
  accessToken: "test-token", refreshToken: "test-refresh", tokenType: "Bearer",
  expiresAtMs: now + 365 * 24 * 3600 * 1000,
  generation: 1, loginAtMs: now, refreshedAtMs: now,
}, null, 2));
' "$MINIMAX_DATA_DIR"
fi

if [ -n "$BASE" ]; then
  export QODER_GLOBAL_INFER_BASE="$BASE/qoder-global"
  export QODER_GLOBAL_LEGACY_BASE="$BASE/qoder-global-legacy"
  export QODER_CN_INFER_BASE="$BASE/qoder-cn"
  export QODER_GLOBAL_OPENAPI_BASE="$BASE/openapi-global"
  export QODER_CN_OPENAPI_BASE="$BASE/openapi-cn"
  export WORKBUDDY_CHAT_BASE="$BASE/workbuddy"
  # The MiniMax upstream is called at <base>/messages; the mock and the
  # recorder both answer on /minimax/v1/messages.
  export MINIMAX_BASE_URL="$BASE/minimax/v1"
  export TOKENRHYTHM_INFER_BASE="$BASE/tokenrhythm/v1"
fi

# The benefits would talk to the upstream for nothing during a test.
export BENEFITS_DISABLED=1

# exec, so the process this script starts is the one that gets killed.
exec node router-proxy.ts
