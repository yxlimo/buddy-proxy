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

# The upstream switches live in the database (provider.enabled), not in the
# environment — test/fake-sessions.ts turns on the ones this test needs.
export ROUTER_PORT="$PORT"

# Everything the service keeps lives in one directory: the database with the
# credentials, the log, the salt. The test gets its own, away from the real
# one.
export BUDDY_DATA_DIR="${BUDDY_DATA_DIR:-/tmp/opencode/test-buddy}"
mkdir -p "$BUDDY_DATA_DIR"

# The upstreams this run serves. TEST_UPSTREAMS says which ones (the relay
# station is only served when its accounts are configured).
export TEST_UPSTREAMS="${TEST_UPSTREAMS:-qoder,qoder-cn,workbuddy-cn,minimax}"

# The router holds the MiniMax credential itself, so it needs one — but the
# mock never looks at it. A dummy session keeps the test away from the real
# one and stops the device flow from starting.
if [ ! -f "$BUDDY_DATA_DIR/minimax-session.json" ]; then
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
' "$BUDDY_DATA_DIR"
fi

# The other upstreams need a credential too, or the router starts their login
# flow and answers 503. They live in the database now, so the dummy sessions
# go there as well.
node --experimental-strip-types test/fake-sessions.ts >/dev/null

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
