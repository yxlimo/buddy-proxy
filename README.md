# buddy-proxy

Two independent proxies in front of free model providers, each its own process
on its own port:

| Process | Port | Upstream | Dialect |
|---------|------|----------|---------|
| `minimax-proxy.ts` | 6448 | MiniMax Code gateway | Anthropic |
| `router-proxy.ts` | 6450 | Qoder **and** MiniMax, chosen per model name | OpenAI + Anthropic |

The router is the one to point a client at when you want both providers behind
one base URL — see [Router](#router-router-proxyts-port-6450).

## What is switched on

There are three reverse proxies behind this, and each has a switch. All three
are **off by default**; turn on the ones you actually use.

| Switch | Turns on |
|--------|----------|
| `MINIMAX_CODE=true` | the MiniMax Code gateway (port 6448) |
| `QODER_GLOBAL=true` | the Qoder global account (qoder.com) |
| `QODER_CN=true` | the Qoder China account (qoder.cn) |
| `WORKBUDDY_CN=true` | the WorkBuddy China account (workbuddy.cn) |

A proxy that is switched off is not looked at: no credential is read, no login
is attempted, no models are advertised, and a request for one is refused with a
message saying which switch to flip. The two Qoder regions are separate
accounts, so they are switched on separately, and WorkBuddy's China account is
a third one.

The router reads all four; the MiniMax proxy reads `MINIMAX_CODE`.

This repository used to also proxy OpenCode's own free tier, by driving the
real `opencode` binary's local server. That is gone: the free tier's
behaviour under a proxy never settled down, and the code that existed for it
has been removed rather than left to rot.

## Setup

```bash
npm install
MINIMAX_CODE=true QODER_GLOBAL=true QODER_CN=true WORKBUDDY_CN=true node router-proxy.ts   # :6450, the one to point a client at
MINIMAX_CODE=true node minimax-proxy.ts                     # :6448, the MiniMax gateway on its own
```

API keys live in `api-keys.json` (auto-generated on first run if missing).

## Layout

```
router-proxy.ts        the entry point: the switches, the routes, the startup
minimax-proxy.ts       the MiniMax Code gateway on its own
lib/router/            the router's inside
  routes.ts            where a request goes: the model name and the path
  catalog.ts           the model lists, in both dialects
  deliver.ts           how an answer reaches the client
  upstreams.ts         the four upstream adapters
  benefits.ts          the daily check-in
lib/dialect/           the conversion between the two dialects
  request.ts           the request
  stream.ts            the streaming answer
  response.ts          the whole answer
lib/qoder-*.ts         Qoder: the session, the models, the two protocols
lib/workbuddy-*.ts     WorkBuddy: the session, the models, the transport
lib/benefits.ts        the daily credits of the China accounts
lib/device-identity.ts the fingerprint of an account
```

The code runs through Node's type stripping, so there is no build step — and
no TypeScript feature that needs more than stripping (no parameter properties,
no enums).

## Testing

The self-test runs against a mock of the upstreams, so it costs no tokens and
always sees the same answers:

```bash
test/smoke.sh       # the whole matrix against the recorded fixtures
```

The matrix covers every upstream in both dialects, streaming and not, plus the
tool call and the refused model. It takes about two seconds.

The fixtures are the real answers, recorded from the real upstreams:

```bash
test/capture.sh     # record the upstreams into test/fixtures/
```

The China region answers slowly and does not go through the recording proxy, so
it is recorded on its own (`test/capture-legacy.ts`).

To run the matrix against the real upstreams instead:

```bash
bash test/run-router.sh 6689 ""   # a router with the real upstreams
bash test/e2e.sh http://127.0.0.1:6689
```

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

Each upstream is a provider of its own, so the model ids are the real ones:

| Provider | Base URL | Upstream |
|---|---|---|
| `qoder_global` | `{router}/qoder/v1` | Qoder, global account |
| `qoder_cn` | `{router}/qoder-cn/v1` | Qoder, China account |
| `workbuddy_cn` | `{router}/workbuddy-cn/v1` | WorkBuddy, China account |
| `minimax_code` | `{router}/minimax/v1` | the MiniMax Code gateway |

The router's MiniMax upstream is the same gateway the standalone proxy on 6448
serves, so the client has one MiniMax Code provider, not two.

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

- The proxy logs itself in: with no session file it runs the device flow at
  startup, printing an authorization URL and a user code. You approve in a
  browser and the credential is written as a single JSON file
  (`~/.minimax-proxy/minimax-session.json`, or `/data/minimax-session.json` in
  the container). The server keeps serving while you approve, so a request in
  the meantime gets a clear 503 rather than a hang.
- This only happens when the proxy is switched on (`MINIMAX_CODE=true`). A
  disabled proxy never looks for a credential at all.
- To log in again, remove the session file and restart — the next start runs the
  device flow.
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
| `MINIMAX_CODE` | `false` | switch this reverse proxy on; a disabled one serves nothing and looks for no credential |
| `MINIMAX_LOG_BODY` | `false` | log the thinking / effort fields of every request |
| `MINIMAX_PING_MS` | `15000` | SSE heartbeat: send `event: ping` when the stream has been quiet this long (`0` disables) |
| `MINIMAX_REFRESH_BUFFER_MS` | `300000` | refresh this far before expiry |
| `MINIMAX_LOCK_STALE_MS` | `30000` | a lock older than this is taken over |

## Router (`router-proxy.ts`, port 6450)

One entry point, two dialects, three upstreams. The model name decides the
upstream; the dialect decides how much translation happens.

| Method | Path | Format |
|--------|------|--------|
| `GET`  | `/v1/models` | every enabled upstream, prefixed ids (`?dialect=openai` for the OpenAI shape) |
| `GET`  | `/{upstream}/v1/models` | one upstream, plain model ids |
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `POST` | `/{upstream}/v1/messages` | the same, addressed to one upstream |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream supported) |
| `POST` | `/{upstream}/v1/chat/completions` | the same, addressed to one upstream |
| `GET`  | `/health` | status of every enabled upstream |

`{upstream}` is one of `qoder`, `qoder-cn`, `workbuddy-cn`, `minimax`.

### Routing

The upstream is chosen by the path, and the model id is the model's own name:

| Base URL | Upstream | Example request |
|---|---|---|
| `{router}/qoder/v1` | Qoder, global account | `{"model": "glm-5.3"}` |
| `{router}/qoder-cn/v1` | Qoder, China account | `{"model": "glm-5.3"}` |
| `{router}/workbuddy-cn/v1` | WorkBuddy, China account | `{"model": "glm-5.3-flash"}` |
| `{router}/minimax/v1` | MiniMax | `{"model": "MiniMax-M3.1-Flash"}` |

A client that can only use one base URL can put the upstream in the model name
instead — `qoder/glm-5.3`, `qoder-cn/glm-5.3`, `workbuddy-cn/glm-5.3`,
`minimax/MiniMax-M3` — at `{router}/v1`. The server prefixes the model
internally either way, so the two spellings mean the same thing.

The prefixed form is also what `/v1/models` at the root lists, and the
per-upstream `/qoder/v1/models` lists the same models with their plain names.

An unknown model gets a 400 that says which upstream it was looked for in,
rather than being sent somewhere at random.

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
# The router logs in by itself: an enabled region with no session runs the device
# flow at startup and prints the URL to approve.
QODER_GLOBAL=true node router-proxy.ts   # qoder.com
QODER_CN=true     node router-proxy.ts   # qoder.cn
```

The two regions need separate logins; the credentials live in separate files
(`qoder-session.global.json`, `qoder-session.cn.json`). An access token is good
for about 30 days, so the refresh path is barely ever taken. To log in again,
remove that region's session file and restart.

The account's own standing is checked on `/health`: Qoder can hold an account
back for reasons a valid token does not reveal (an IP the account may not be
used from, a disabled app, a lapsed login).

### Environment

| Variable | Default | What |
|----------|---------|------|
| `ROUTER_PORT` | `6450` | router port |
| `MINIMAX_UPSTREAM_URL` | `http://127.0.0.1:6448` | where the MiniMax proxy is |
| `MINIMAX_CODE` | `false` | switch the MiniMax Code upstream on |
| `QODER_GLOBAL` | `false` | switch the Qoder global region on |
| `QODER_CN` | `false` | switch the Qoder China region on |
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

## WorkBuddy (China account)

WorkBuddy is Tencent's coding assistant. This speaks to the China account
(`workbuddy.cn`), which is a different account from the international one
(`workbuddy.ai`) and needs its own login.

### Protocol

The upstream speaks the OpenAI chat-completions dialect, so a request body goes
out almost unchanged. What it checks is the identity around it: the account,
the conversation, and a trace, in the shape the official CLI sends. The proxy
reproduces that shape (`lib/workbuddy-auth.ts`).

Two things are not what they look like:

- **The upstream always answers with a stream**, even for a client that asked
  for none. A non-streaming request is folded back into one completion object
  here.
- **The catalogue comes from the upstream** at `GET /v3/config`, and the
  upstream adds models without a client release. The proxy fetches it at
  startup and every half hour, and trims it the way the official picker does:
  no completion-only models, no tier aliases, no paid build of a name the list
  already carries (`hy3-x` next to the free `hy3`), and no paid sibling of a
  free one. The bundled snapshot is only the fallback.

### Login

The login is the browser one: the proxy asks for a state, sends you to
`https://www.workbuddy.cn/login`, and polls until you approve. The token is a
JWT whose `sub` claim is the account id. The refresh token rotates on every
refresh, so the session file must survive restarts.

```bash
WORKBUDDY_CN=true node router-proxy.ts   # prints the login URL
```

### Models

18 models as of 2026-10-21, from `hy3` and `step-5-preview` (free) through
`kimi-k3-1` (the most expensive). The label carries the credit multiplier, so
the list reads as a price list: `Hy3 免费`, `GLM-5.3-Flash 0.08×`,
`Kimi-K3 1.62×`.

`glm-5.1` is in the upstream's own catalogue but every request for it is
rejected with code 11133, so it is left out.

### Environment

| Variable | Default | What |
|----------|---------|------|
| `WORKBUDDY_CN` | `false` | switch the WorkBuddy China upstream on |
| `WORKBUDDY_CN_BASE` | `https://www.workbuddy.cn` | the host that serves the account |
| `WORKBUDDY_CN_ORIGIN` | `https://www.codebuddy.cn` | Origin / Referer on the auth calls |
| `WORKBUDDY_DATA_DIR` | `~/.workbuddy-proxy` | where the session file lives (`/data` in Docker) |
| `WORKBUDDY_CATALOG_TTL_MS` | `1800000` | how long the upstream's catalogue is trusted |
| `WORKBUDDY_REFRESH_BUFFER_MS` | `86400000` | refresh this far before expiry |
| `WORKBUDDY_AUTH_WARN_MS` | `604800000` | warning window before expiry |
| `WORKBUDDY_LOGIN_TIMEOUT_MS` | `600000` | how long to wait for the browser approval |

## Device fingerprint

Both upstreams look at the machine code and the session id that come with a
request. The official client keeps one machine id for the whole installation —
so two accounts on it look like two accounts on one device, which is what a
risk check looks for.

The router derives the pair from the account instead:

| | Qoder | WorkBuddy |
|---|---|---|
| machine code | `Cosy-MachineId`, `Cosy-MachineToken`, `Cosy-Machine-Type`, `Cosy-MachineCode` | `X-Device-Id` |
| session id | `X-Session-ID` | — |

So the same account always looks like the same machine and nothing drifts,
and no two accounts ever look like the same machine. The derivation is salted
with a secret of the installation (`identity.salt`, next to the sessions), so
the machine token cannot be worked out from the account id alone, and two
installations of the same account do not correlate either.

The salt lives in the data volume, so a rebuild keeps the fingerprint. Losing
it only means a new fingerprint, not a lost login.

## Daily benefits

Both China accounts hand out credits for showing up, and the router takes them
without being asked. It runs when it starts and then every six hours; the day
rolls over at midnight in China, and every call is idempotent — asking twice
answers "already done" rather than doing it again.

| Account | What it takes |
|---|---|
| WorkBuddy | the daily check-in (`/v2/billing/meter/daily-checkin`), and then the growth centre: the gift the travelling Buddy brings back, the tasks, the make-up cards for a missed day, the streak tier, and the blind box |
| Qoder | the campaigns (`/sash/api/v1/me/campaigns`) that are claimable |

The WorkBuddy growth centre is a chain of calls: take the gift, send the Buddy
out again so there is one to collect tomorrow, accept the tasks that are not
accepted, claim the ones that are finished, use a make-up card for a day that
was missed, redeem the tier the streak unlocked, and open one blind box. A
draw cannot be undone, so only one is opened per run.

The Qoder campaigns come back **empty** without the `Cosy-ClientType` header,
so that one is not optional.

The result of the last run is in `/health` under `benefits`:

```json
"benefits": {
  "enabled": true,
  "intervalMs": 21600000,
  "lastRunAt": "2026-10-21T03:07:50.801Z",
  "running": false,
  "lastOutcome": [
    { "upstream": "workbuddy-cn", "credits": 0, "report": ["今日已签到（连签 1 天）"] },
    { "upstream": "qoder-cn", "credits": 0, "report": ["活动「act-20261020-791」已领过"] }
  ]
}
```

Each upstream that is switched on takes its own benefits; one that is off is
not looked at.

| Variable | Default | What |
|----------|---------|------|
| `BENEFITS_INTERVAL_MS` | `21600000` | how often the check-in runs |

## Deployment (Docker)

The image carries the code. The NAS never receives a checkout — it holds a
`docker-compose.yml` and a `./data` directory, and nothing else. The image is
built locally and shipped there as a tar.

The compose file runs two services from that one image: `minimax-proxy` on
6448 and `router` on 6450. The router reaches the MiniMax proxy by service name
over the compose network, so there is no host port to configure.

```bash
podman build --format docker -t localhost/buddy-proxy:latest .
podman save --format docker-archive -o buddy-proxy.tar localhost/buddy-proxy:latest
scp buddy-proxy.tar docker-compose.yml <host>:/path/to/service/
ssh <host> 'cd /path/to/service && docker load && docker tag localhost/buddy-proxy:latest buddy-proxy:latest && docker compose up -d'
```

`--format docker` matters twice over: podman's default OCI format drops
`HEALTHCHECK`, and `docker load` needs the docker archive format anyway.

Two details that are easy to get wrong:

- `docker load` tags the image `localhost/buddy-proxy:latest`, but the compose
  file says `buddy-proxy:latest`. Without the retag the compose file keeps
  resolving to the previous image and the new one is silently never used.
- The build needs the npm registry. When it is slow the `pnpm install` layer
  fails on a download; rerun it, the layer is cached and the retry is quick.

The service directory holds the compose file and a `./data` directory mounted at
`/data`, and nothing else.

The login is the only step that needs a human, and the services do it
themselves: a switched-on proxy with no session in `./data` runs the device
flow at startup and prints the authorization URL and user code to its log.
Approve it in a browser and the credential lands in `./data`. Every later
refresh is done by the proxy itself. To log in again, remove the session file
from `./data` and restart.

```bash
docker compose logs -f          # the authorization URL shows up here
```

`./data` must survive rebuilds — the refresh token rotates on every refresh, so a
lost file means logging in again.
