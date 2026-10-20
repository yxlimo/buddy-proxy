# buddy-proxy

Two independent proxies in front of free model providers, each its own process
on its own port:

| Process | Port | Upstream | Dialect |
|---------|------|----------|---------|
| `minimax-proxy.ts` | 6448 | MiniMax Code gateway | Anthropic |
| `router-proxy.ts` | 6450 | Qoder **and** MiniMax, chosen per model name | OpenAI + Anthropic |

The router is the one to point a client at when you want both providers behind
one base URL — see [Router](#router-router-proxyts-port-6450).

This repository used to also proxy OpenCode's own free tier, by driving the
real `opencode` binary's local server. That is gone: the free tier's
behaviour under a proxy never settled down, and the code that existed for it
has been removed rather than left to rot.

## Setup

```bash
npm install
node router-proxy.ts    # :6450, the one to point a client at
node minimax-proxy.ts   # :6448, the MiniMax gateway on its own
```

API keys live in `api-keys.json` (auto-generated on first run if missing).

## Endpoints

| Method | Path | Format |
|--------|------|--------|
| `GET`  | `/v1/models` | OpenAI model list |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream supported) |
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `GET`  | `/health` | status |

Auth: `Authorization: Bearer <key>` (OpenAI) or `x-api-key: <key>` (Anthropic).
Base URL: `http://localhost:6450` (use `.../v1` for OpenAI clients).

```bash
# OpenAI format
curl http://localhost:6450/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"qoder/auto","messages":[{"role":"user","content":"hi"}]}'

# Anthropic format
curl http://localhost:6450/v1/messages \
  -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"model":"qoder/auto","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

## Client model lists

The opencode **TUI** model picker lists each model exactly once: anything
already shown under **Favorites** or **Recent** is not repeated in the
per-provider section further down. A provider whose models are all in
Favorites/Recent therefore shows no group at all — the models are still there,
just above. `opencode models`, `/api/model` and pi list everything regardless.

So if a model "disappears" from the picker, look at Favorites/Recent or type in
the search box before assuming the proxy or the config lost it.

The opencode **web UI** is separate again: it keeps the picker's contents in the
browser's `localStorage` (key `opencode.global.dat:model`), and a custom
provider's models are not in there by default. Open the picker → **Manage
models** → flip the provider's switch (one switch covers all its models). That
is per-browser.

## MiniMax Code proxy (`minimax-proxy.ts`, port 6448)

A second, independent process in front of the MiniMax Code LLM gateway. It shares
`lib/` with the proxy above (env loading, API-key auth) but has its own entry
point, port, and credential source.

```bash
mise run serve-minimax     # or: node minimax-proxy.ts
```

Only the Anthropic dialect is exposed — the upstream is already an Anthropic
`/v1/messages` endpoint, so requests pass through verbatim (system, thinking,
tools, streaming).

| Method | Path | Format |
|--------|------|--------|
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `GET`  | `/v1/models` | model catalog |
| `GET`  | `/health` | status, including credential state |

`/v1/messages` is the only chat path, matching Anthropic's own versioning
(`https://api.anthropic.com/v1/messages`). Clients append `/messages` to their
base URL, so the base URL is expected to carry the `/v1` segment — opencode and
the Anthropic SDK use `<base>/v1/messages`, and pi (whose `baseUrl` is a plain
root) uses `<base>/v1/messages` as well.

What makes the gateway treat this as a MiniMax Code client is the OAuth grant
itself — `client_id=mcode-public`, `audience=agent-backend`, `scope=agent.default`
— not a header trick. The token read from the desktop app's store is already a
MiniMax Code credential.

### Credential

Two sources, picked by `MINIMAX_AUTH_MODE` (`lib/minimax-auth.ts` dispatches):

**`oauth`** (default, required in Docker) — the proxy owns its own session:

- One-time device-flow login (`scripts/minimax-login.ts`): it prints an
  authorization URL and a user code, you approve in a browser, and the credential
  is written as a single JSON file (`~/.minimax-proxy/minimax-session.json`, or
  `/data/minimax-session.json` in the container).
- After that the proxy refreshes itself every hour, with PKCE (S256) and a file
  lock. The refresh token rotates on every refresh, so the file must be persisted
  — losing it means logging in again.
- This is a separate login, so it does not touch the desktop app's `generation`.

**`file`** — a strictly read-only view of the desktop app's store:

```
~/.minimax/auth/prod/cn/mcode-public/     (or /mnt/d/.minimax/... on WSL)
  auth-state.json   authoritative: status, generation, activeRecord
  auth.json         fallback: records keyed by generation
```

- It never refreshes. Refreshing would bump the server-side `generation` and log
  the desktop app out, so the app must be opened regularly — access tokens live
  ~1 hour, and the app only refreshes when it is running.

Both modes: when the credential is missing, unreadable, or expired, requests
answer `503` with a Chinese hint telling you to re-login, and `/health` reports
the same. A warning is logged when the token enters the last 10 minutes, and a
background watch logs the state every 5 minutes even without traffic.

### Models

The gateway has no `/models` route (`direct_route_not_configured`), so
`GET /v1/models` is served from a local catalog (`lib/minimax-models.ts`):

| id | context | max output | notes |
|----|---------|------------|-------|
| `MiniMax-M3.1-Flash` | 1,000,000 | 128,000 | default |
| `MiniMax-M3` | 1,000,000 | 128,000 | |

The limits follow the desktop app's own config (`limit.output: 128000`,
`defaultModelContextWindow: 1000000`); models.dev reports 512k output instead,
and the client picks the lower one on purpose so a planned response is never
cut. The gateway validates neither number up front, so both are advisory
budgeting values.

The gateway does **not** validate model ids either: an unrecognized name (say
`MiniMax-M3.1`) is silently routed to `MiniMax-M3` instead of failing. The
`model` field in the response tells you what actually ran.

### Clients

- **pi** — `~/.pi/agent/models.json` has a `minimax-code` provider
  (`baseUrl: http://<proxy-host>:6448`, `api: anthropic-messages`) listing both
  models with `contextWindow: 1000000` / `maxTokens: 128000`, a
  `thinkingLevelMap` (pi's `off|minimal|low|…|max` → the gateway's effort
  values) and `compat.forceAdaptiveThinking: true`, so pi sends the same
  `thinking: {type: "adaptive"}` + `output_config: {effort: …}` the desktop
  client sends. Pick a level with `pi --model MiniMax-M3.1-Flash:high`.
- **opencode** — `~/.config/opencode/opencode.jsonc` has a `minimax-code`
  provider (`npm: @ai-sdk/anthropic`, `baseURL: http://<proxy-host>:6448/v1`)
  with the same two models and limits. The thinking levels are declared as
  `capabilities.reasoning.effort` — opencode turns that into model variants
  (`low`/`medium`/`high`/`xhigh`/`max`), selectable as
  `opencode run -m minimax-code/MiniMax-M3.1-Flash#high`. Hand-written
  `variants` entries in the config are rejected as a legacy setting, and
  `settings` inside a variant is not accepted either — `capabilities.reasoning`
  is the supported way.

The `/v1` in the base URL is Anthropic's version segment, exactly like the
official `https://api.anthropic.com/v1` example in the opencode docs.

### Thinking and effort

The gateway speaks the Anthropic dialect for reasoning: thinking is
`thinking: {type: "adaptive"}`, and the effort level rides along in
`output_config: {effort: …}` with `low | medium | high | xhigh | max`.
`MiniMax-M3.1-Flash` forces adaptive thinking — sending
`thinking: {type: "disabled"}` is rejected with
`requires adaptive thinking` — while `MiniMax-M3` accepts it.

Set `MINIMAX_LOG_BODY=true` to have the proxy log the thinking / effort fields
of every request; it is the only way to see what a client actually asked for,
since the gateway does not echo them back. With it on, the proxy also logs the
outcome of every streamed response (`[RES] … done 1234ms bytes=… pings=…`, or
`FAILED after … cause=…`), which is what tells an upstream failure apart from a
connection dropped by a hop in front of the proxy.

### Heartbeat

The gateway sends one `event: ping` right after `message_start` and then stays
silent for as long as the model thinks — a long thinking pause can keep the
stream quiet for minutes. Any hop in front of the proxy (a local HTTP proxy, a
NAT gateway) may drop such an idle connection. The proxy therefore sends its
own `event: ping` when the stream has been quiet for `MINIMAX_PING_MS`
(default 15s), using the same payload the gateway uses, so clients ignore it.

A ping is only written on an SSE frame boundary — writing one in the middle of
an upstream frame would corrupt the client's parse — and only when the stream
is actually idle, so a busy stream is not padded with useless events.

### Environment

| Variable | Default | What |
|----------|---------|------|
| `MINIMAX_PORT` | `6448` | proxy port |
| `MINIMAX_AUTH_DIR` | auto-detected | credential store directory |
| `MINIMAX_REGION` | `cn` | store subdirectory (`cn` / `global`) |
| `MINIMAX_CLIENT_ID` | `mcode-public` | OAuth client id |
| `MINIMAX_AUTH_CACHE_MS` | `5000` | how long a read of the store is reused |
| `MINIMAX_AUTH_WARN_MS` | `600000` | warning window before expiry |
| `MINIMAX_WATCH_MS` | `300000` | background watch interval |
| `MINIMAX_ATTRIBUTION_HEADERS` | `true` | send the client's attribution headers |
| `MINIMAX_USER_AGENT` | `MiniMaxCode` | User-Agent sent upstream |
| `MINIMAX_ANTHROPIC_VERSION` | `2023-06-01` | `anthropic-version` sent upstream |
| `MINIMAX_BASE_URL` | `https://agent.minimax.cn/mavis/api/v1/llm/v1` | gateway base URL |
| `REQUIRE_API_KEY` | `false` | enforce `api-keys.json` keys |
| `MINIMAX_AUTH_MODE` | `oauth` | `oauth` (proxy's own session) or `file` (read-only app store) |
| `MINIMAX_DATA_DIR` | `~/.minimax-proxy` | where the oauth session file lives (`/data` in Docker) |
| `MINIMAX_CREDENTIAL_FILE` | — | explicit session file path, overrides `MINIMAX_DATA_DIR` |
| `MINIMAX_AUTO_LOGIN` | `true` | start the device flow at boot when there is no session |
| `MINIMAX_LOG_BODY` | `false` | log the thinking / effort fields of every request |
| `MINIMAX_PING_MS` | `15000` | SSE heartbeat: send `event: ping` when the stream has been quiet this long (`0` disables) |
| `MINIMAX_REFRESH_BUFFER_MS` | `300000` | refresh this far before expiry |
| `MINIMAX_LOCK_STALE_MS` | `30000` | a lock older than this is taken over |

## Router (`router-proxy.ts`, port 6450)

One entry point, two dialects, two upstreams. The model name decides the
upstream; the dialect decides how much translation happens.

| Method | Path | Format |
|--------|------|--------|
| `GET`  | `/v1/models` | both upstreams, prefixed ids (`?dialect=openai` for the OpenAI shape) |
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream supported) |
| `GET`  | `/health` | status of both upstreams |

### Routing

The model name carries the upstream:

| Model name | Upstream | Model sent upstream |
|---|---|---|
| `qoder/auto`, `qoder/ultimate` | Qoder | `auto`, `ultimate` |
| `minimax/MiniMax-M3.1-Flash` | MiniMax | `MiniMax-M3.1-Flash` |
| `auto` (no prefix) | Qoder if it is in the Qoder catalog, else MiniMax | as given |

An unknown model gets a 400 that says to use a prefix, rather than being sent
somewhere at random.

### Dialect handling

Each dialect is cheapest on the upstream that speaks it natively, so each
request is translated at most once:

| Request dialect | Upstream | What happens |
|---|---|---|
| OpenAI | Qoder | passed through — the Qoder gateway is an OpenAI endpoint |
| OpenAI | MiniMax | converted to Anthropic, and the response back to OpenAI |
| Anthropic | Qoder | converted to OpenAI, and the response back to Anthropic |
| Anthropic | MiniMax | passed through |

The conversion covers tools (both schema directions), tool calls in the
response, streaming and non-streaming, and the thinking channel: Anthropic
`thinking` blocks become OpenAI `reasoning_content` and back. Tool arguments
that arrive split across OpenAI stream fragments are buffered and emitted once
they form valid JSON, because Anthropic expects a whole JSON document.

### Models

Qoder's catalog splits in two.

**Tiers** are one capability at different thinking levels. Qoder picks the
model; the tier sets how hard it thinks. They are exposed as a single model
with effort levels, so a client asks for `qoder/auto` plus a level rather than
for four separate models:

| id | upstream tier | thinking |
|---|---|---|
| `qoder/auto` | `auto` (low, medium) / `ultimate` (high, max) | yes |

**Pinned models** are one model each. Their thinking is fixed — the catalog
says which — so they have no effort levels:

| id | upstream key | protocol | thinks |
|---|---|---|---|
| `qoder/qwen3.7-plus` | `qmodel` | new | no |
| `qoder/kimi-k2.8-preview` | `kmodel` | new | no |
| `qoder/glm-5.3` | `gmodel` | new | yes |
| `qoder/deepseek-v4-pro` | `dmodel` | new | yes |
| `qoder/minimax-m3.1-flash` | `mmodel` | new | yes |

"new" is the plain OpenAI endpoint on `api2-v2.qoder.sh`; "legacy" is Qoder's
COSY-signed protocol on `api3.qoder.sh`, which is the only one that speaks the
version-pinned keys. The gateway reports the backend it actually used in
`usage.raw_usage.model`.

**The global region serves the new protocol only**, so the catalog it
advertises is the six entries above. The version-pinned models — `qmodel_latest`
(Qwen3.7-Max), `qmodel_38max` (Qwen3.8-Max), `qfmodel` (Qwen3.8-Flash),
`kmodel_latest` (Kimi-K3), `gfmodel` (GLM-5.3-Flash), `dfmodel`
(DeepSeek-Flash), `cmodel` (Cantus), `smodel` (Sonus) — are legacy-only, and on
a global account that path does not answer: 403 (queued), "All backends
failed", and once the day's free count is used up, 110 "Billing daily count
exceeded". They stay in `lib/qoder-models.ts` for the CN region, which does run
the legacy protocol, but the global catalog leaves them out and a request for
one is refused with a clear message instead of being sent to an upstream that
will not answer.

### The CN region

The Chinese gateway is the other way round: it has not deployed the new
protocol (404/503 on `gateway.qoder.com.cn/model/v1/chat/completions`) and
speaks the legacy protocol only. Its legacy endpoint accepts *both* key
vocabularies — the plain ones (`qmodel`, `kmodel`, `gmodel`, `dmodel`,
`mmodel`) as well as the version-pinned ones — so the CN catalog is the full
set. Measured 2026-10-20: 13 of the 14 answer; the two effort tiers
(`ultimate`, `efficient`) are not in the CN catalog at all, and `dfmodel`
(DeepSeek-Flash) sits in the queue and never clears.

Both regions are served by the one router, with the region in the model name:

| model id | goes to |
|---|---|
| `qoder/glm-5.3` | global account, new protocol |
| `qoder-cn/glm-5.3` | Chinese account, legacy protocol |

A client model id cannot hold a slash, so the CN models are called
`cn-glm-5.3` and so on. The client configs list both sets: the router's
`/v1/models` is the source of truth, and the opencode and pi configs are
rewritten from it.

Which models are free depends on the account: the usage block reports
`billable` and `credits`, and on the CN account `Qwen3.8-Flash`, `Cantus` and
`Sonus` come back `billable: false`, while the others report a small credit
charge.

### Credit multipliers

The model list carries the credit multiplier the Qoder client shows, so the
picker says what a request costs before you pick one — `GLM-5.3 0.8×`,
`Kimi-K3 1.4×`, `Qwen3.7-Plus 0.1×`, and `0×` for the ones that cost nothing
(`Cantus`, `Sonus`, and the models whose listed multiplier was cut to zero).

The multiplier lives in the display name only. The request the gateway gets
keeps the plain name, and the client's model id is unchanged, so nothing about
the wire format depends on it.

The tool round trip needs one extra thing on the legacy protocol: the request
has to carry the assistant's tool calls and the tool's answer inside
`response_meta`, or the model cannot tell that it already made the call and
calls the tool again — forever. `lib/qoder-legacy.ts` puts them there in the
OpenAI shape the upstream itself uses (`{id, type, function:{name, arguments}}`).


### Thinking levels

Qoder's protocol has no per-request thinking switch — the tier *is* the
switch. The proxy therefore reads the level from the request and translates it
into a tier:

| level | tier |
|---|---|
| `low`, `medium` | `auto` (does not think) |
| `high`, `max` | `ultimate` (thinks) |

The level is read from `output_config.effort` (what opencode and pi send),
`effort`, `reasoning_effort`, or `thinking.budget_tokens`. Override the
mapping with `QODER_EFFORT_TIERS=low=efficient,medium=auto,high=ultimate,max=ultimate`.

The upstream queues models and answers 403/429 while they wait. The proxy
retries those the way the official CLI does.

MiniMax's catalog is unchanged: `MiniMax-M3.1-Flash` (default) and
`MiniMax-M3`.

### Qoder login

Qoder's CLI uses a PKCE device flow with no device-code endpoint: the challenge
is computed locally, the user approves it in a browser, and the proxy polls with
the verifier. A 404 from the poll endpoint means "still waiting for you", not a
failure. The session is the proxy's own — it refreshes itself, and the refresh
token rotates on every refresh, so the file must be persisted.

```bash
node scripts/qoder-login.ts --region global   # qoder.com
node scripts/qoder-login.ts --region cn       # qoder.cn
node scripts/qoder-login.ts --status
```

The two regions need separate logins; the credentials live in separate files
(`qoder-session.global.json`, `qoder-session.cn.json`). An access token is good
for about 30 days, so the refresh path is barely ever taken.

The account's own standing is checked on `/health`: Qoder can hold an account
back for reasons a valid token does not reveal (an IP the account may not be
used from, a disabled app, a lapsed login).

### Environment

| Variable | Default | What |
|----------|---------|------|
| `ROUTER_PORT` | `6450` | router port |
| `MINIMAX_UPSTREAM_URL` | `http://127.0.0.1:6448` | where the MiniMax proxy is |
| `QODER_REGION` | `global` | which Qoder region to talk to (`cn` / `global`) |
| `QODER_DATA_DIR` | `~/.qoder-proxy` | where the session file lives (`/data` in Docker) |
| `QODER_AUTH_CACHE_MS` | `5000` | how long a read of the session is reused |
| `QODER_AUTH_WARN_MS` | `604800000` | warning window before expiry (a Qoder token lasts ~30 days) |
| `QODER_REFRESH_BUFFER_MS` | `86400000` | refresh this far before expiry |
| `QODER_LEGACY_ATTEMPTS` | `3` | attempts for a legacy-protocol request before giving up |
| `QODER_LEGACY_RETRY_MS` | `10000` | wait between those attempts |
| `QODER_MAX_ATTEMPTS` | `3` | attempts for a new-protocol request before giving up |
| `QODER_EFFORT_TIERS` | — | override the thinking level → tier mapping |
| `QODER_LOG_ROUTE` | `false` | log the model and tier each request resolved to |
| `REQUIRE_API_KEY` | `false` | enforce `api-keys.json` keys |

## Deployment (Docker)

The image carries the code. The NAS never receives a checkout — it holds a
`docker-compose.yml` and a `./data` directory, and nothing else. The image is
built locally and shipped there as a tar.

The compose file runs two services from that one image: `minimax-proxy` on
6448 and `router` on 6450. The router reaches the MiniMax proxy by service name
over the compose network, so there is no host port to configure.

```bash
./scripts/deploy-nas.sh              # build, export, load on the NAS, reload
./scripts/deploy-nas.sh --no-build   # ship the current local image as-is
```

The script runs `podman build --format docker`, exports with
`podman save --format docker-archive`, copies the tar plus the compose file over
SSH, runs `docker load`, retags `localhost/buddy-proxy:latest` to the name the
compose file uses, deletes any source left on the NAS, and recreates the
container. `--format docker` matters twice over: podman's default OCI format
drops `HEALTHCHECK`, and `docker load` needs the docker archive format anyway.

Two details that are easy to get wrong:

- `docker load` tags the image `localhost/buddy-proxy:latest`, but the compose
  file says `buddy-proxy:latest`. Without the retag the compose file keeps
  resolving to the previous image and the new one is silently never used.
- The build needs the npm registry. When it is slow the `pnpm install` layer
  fails on a download; rerun it, the layer is cached and the retry is quick.

The service is deployed on the NAS at `/srv/buddy-proxy/`, with
`./data` mounted at `/data`.

```bash
docker compose exec minimax-proxy node scripts/minimax-login.ts   # one-time, prints URL + user code
docker compose exec minimax-proxy node scripts/minimax-login.ts --status
docker compose exec router node scripts/qoder-login.ts --region global
```

The login is the only step that needs a human: it prints an authorization URL and
a user code, you approve in a browser, and the credential lands in `./data`. Every
later refresh is done by the proxy itself. `MINIMAX_AUTO_LOGIN` is set to `false`
in the compose file so the code is read from the login command rather than the logs.

`./data` must survive rebuilds — the refresh token rotates on every refresh, so a
lost file means logging in again.
