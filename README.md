# buddy-proxy

One reverse proxy in front of free model providers. It answers in both
dialects, and the model name decides which upstream the request goes to:

| Process | Port | Upstreams | Dialect |
|---------|------|-----------|---------|
| `router-proxy.ts` | 6450 | MiniMax Code, MiniMax open platform, Qoder (two regions), WorkBuddy, TokenRhythm, ZCode, SenseNova, 书生·端砚 | OpenAI + Anthropic |

Point a client at it and it works with either dialect — see
[Router](#router-router-proxyts-port-6450).

## What is switched on

There are nine upstreams behind this, and each has a switch. All of them
start **off**; turn on the ones you actually use, in the panel.

The switch is a row in the gateway's database, not an environment variable:
the panel's 上游 tab has one switch per account, and the next request after you
flip it is the first one that changes. Nothing in the environment decides which
account runs — that was the old arrangement, and it is gone.

A **platform** is written in the code (`lib/platforms.ts`): it is one service,
and its id is the segment in the request path. An **account** is a row in the
gateway's database: one login identity. One platform can hold several accounts —
two MiniMax Code subscriptions, or one relay-station tenant each.

| Platform (path) | What it is |
|-----------------|------------|
| `minimax` | the MiniMax Code gateway |
| `minimax-api` | the MiniMax open platform (api.minimax.cn), by API key |
| `zcode` | ZCode (zcode.z.ai), the GLM coding client |
| `qoder` | the Qoder global service (qoder.com) |
| `qoder-cn` | the Qoder China service (qoder.cn) |
| `workbuddy-cn` | WorkBuddy China (workbuddy.cn) |
| `tokenrhythm` | the TokenRhythm relay station (tokenrhythm.studio) |
| `sensenova` | SenseNova (token.sensenova.cn) |
| `intern-ai` | InternAI's open platform (discovery-api.intern-ai.org.cn) |

A fresh install has no accounts at all: the panel's 上游 tab lists the nine
platforms, and you add an account to the one you want. An account that is
switched off is not looked at: no credential is read, no login is attempted,
and a request that would land on it goes to the other accounts of the platform
(unless the platform's policy says otherwise). With no enabled account on a
platform, a request for it is refused with a message saying so.

The policy — `single`, `fallback`, `expiry_first` — belongs to the platform,
not to an account: it says how that platform's accounts take turns. A single
account cannot decide on its own whether to hand a request to another one.

The two Qoder regions are two upstreams of the same platform, and WorkBuddy's
China account is a third one. One upstream can carry several **providers**
(the accounts): the TokenRhythm relay has three, the MiniMax open platform
has one per API key. The upstream's own policy decides which of its providers
takes a request.

One process reads all nine.

This repository used to also proxy OpenCode's own free tier, by driving the
real `opencode` binary's local server. That is gone: the free tier's
behaviour under a proxy never settled down, and the code that existed for it
has been removed rather than left to rot.

## Setup

```bash
mise install          # the tool versions this project expects
pnpm install          # the dependencies
node router-proxy.ts   # :6450
```

The upstreams are all off until you switch them on in the panel; the service
starts with none of them and waits for you to say which ones to serve.

The credentials live in the database (`/data/buddy.db` by default) and the
settings in the same place. `api-keys.json` is only the fallback for the
front-door keys of a deployment that predates the database.

## The settings

Every setting comes from one of three places, and the first one that has an
answer wins:

1. **the database** — what a management panel writes
2. **the environment** — what the deployment sets (`docker compose`, `.env`)
3. **the default in the code**

The service reads them all once, at startup, so a change in the database takes
effect on the next restart rather than halfway through a request. The startup
log says where each non-default value came from:

```
[CONFIG] 61 settings (0 from the database, 12 from the environment, 49 default)
[CONFIG] HEALTH_CACHE_MS = 300000  [environment]
```

The settings can be looked at and changed without touching the environment:

```bash
node config-cli.ts list             # what the service will use
node config-cli.ts overrides        # what the database holds
node config-cli.ts set HEALTH_CACHE_MS=60000
node config-cli.ts clear HEALTH_CACHE_MS
node config-cli.ts secrets          # the credentials that are configured
```

The credentials are the exception: the environment wins for them, so a key that
was rotated in `.env` takes effect. The database holds a copy, so the service
still works when the `.env` file is not there.

## Layout

```
router-proxy.ts        the entry point: the routes, the startup
config-cli.ts          look at the settings, and change them
lib/config.ts          the settings, and where they come from
lib/store.ts           the database: the credentials, the settings, the cache
lib/paths.ts           the one directory everything lives in
lib/providers.ts       the providers: the rows, their kind, their secrets
lib/provider-kinds.ts  what a kind of upstream can do: how to log in, what to ask
lib/kinds.ts           the registry the panel and the router read
lib/session.ts          the session: read it, write it, lock it, refresh it
lib/credential.ts       the shared credential shapes, and the auth log
lib/usage.ts            the request-level usage log
lib/agent.ts            who sent the request: pi, opencode, dsh
lib/aggregate.ts        the published models: the catalog, the targets, the traffic
lib/benefits.ts         the daily credits of the China accounts
lib/http.ts             the HTTP client (node:http, so no browser headers)
lib/api-keys.ts         the front door: the keys the agents use
lib/device-identity.ts  the fingerprint of an account
lib/sse-stream.ts       reading an event stream
lib/env.ts             reading the environment
lib/ids.ts             the id helpers
lib/router/            the router's inside
  routes.ts            where a request goes: the model name and the path
  catalog.ts           the model lists, in both dialects
  deliver.ts           how an answer reaches the agent
  upstreams.ts         the upstream adapters
lib/dialect/           the conversion between the two dialects
  request.ts           the request
  stream.ts            the streaming answer
  response.ts          the whole answer
lib/admin/             the panel's side: the Connect service
  service.ts           the thirty-odd methods of the contract
  accounts.ts          the accounts and their credentials
  credentials.ts       the credential words, and the key writing
  config.ts            the settings the panel may change
  upstreams.ts         what each upstream has: the credential, the quota, the state
  models.ts            the published models
  usage.ts             the usage summary
  benefits.ts          the daily check-in
  login.ts             the logins: the browser, the password, the code
  token.ts             the panel's own token
  log.ts               the tail of the log
  http.ts              the Connect transport
lib/qoder/              Qoder: the session, the models, the two protocols
  auth.ts               the device flow, the session, the refresh
  models.ts             the model catalog, in both dialects
  transport.ts          the gateway, in the current protocol
  legacy.ts             the gateway, in the legacy COSY protocol
  credits.ts            the quota, and whether the account is usable
  benefits.ts           the daily campaign
  sgsdk.ts              the machine identity (the real one, and how to get it)
lib/workbuddy/          WorkBuddy: the session, the models, the transport
  auth.ts               the browser login, the session, the refresh
  models.ts             the catalogue, curated the way the simulated client shows it
  transport.ts          the chat endpoint
  api.ts                the account's own API
  credits.ts            what the account has left
  benefits.ts           the check-in, the growth centre
lib/minimax/            MiniMax: the session, the models, the gateway call
  auth.ts               picks the credential source
  oauth.ts              the proxy's own session: the device flow, the refresh
  file-store.ts         read-only view of the desktop app's store
  models.ts             the model catalog
  transport.ts          the call to the MiniMax Code gateway
  credits.ts            what the accounts have left
  checkin.ts            the daily sign-in
  api.ts                the open platform: the tenants, their keys, their plans
lib/zcode/              ZCode (the GLM coding client)
  auth.ts               the browser login, the session
  models.ts             the model catalog
  transport.ts          the inference endpoint
  credits.ts            the Start Plan's allowance
lib/tokenrhythm/        TokenRhythm: the accounts, the wallet, the relay call
  accounts.ts           the tenants, the session, the login
  wallet.ts             what the accounts have left, and which one to use
  models.ts             the model catalog
  transport.ts          the relay call
  platform.ts           the platform's own API (the cookies, the writes)
  keys.ts               the API keys of the tenants
lib/sensenova/          SenseNova: the login, the keys, the pools, the relay call
  auth.ts               the login with a password, the cookie session, the refresh
  keys.ts               the API keys, and the pools they draw from
  models.ts             the model catalog
  quota.ts              the pools: how much is left in each
  transport.ts          the inference endpoint
lib/intern-ai/          书生·端砚: the login, the keys, the credits, the relay call
  auth.ts               the SSO session, the shared uaa-token
  keys.ts               the API keys of the two sub-sites
  models.ts             the model catalog, from the inference endpoint and the console
  quota.ts              the credits, and the packs they come in
  transport.ts          the inference endpoint
proto/buddy/admin/v1/   the contract the panel and the gateway share
lib/gen/                the generated code for it (both sides use this copy)
web/                    the panel: React, Vite, shadcn/ui, Connect
test/                   the tests, the mock, the recorded fixtures
tools/                  the scripts of one machine (not in the repository)
```

The code runs through Node's type stripping, so there is no build step — and
no TypeScript feature that needs more than stripping (no parameter properties,
no enums).

The HTTP layer is Koa 3, with `@koa/router` for the paths and
`koa-bodyparser` for the JSON body. The body is parsed after the key is
checked, so a request that is turned away costs no parsing at all.

## Tasks

The common tasks are in `mise.toml`; the ones that belong to one machine (the
deploy to that machine, the logs on it) are in `mise.local.toml`, which is not
in the repository.

```bash
mise run test          # the offline self-test
mise run typecheck
mise run web:build
mise run build         # the panel and the image
mise run proto         # regenerate the contract's code
```

The test tasks are separate so a change can be checked on its own:

| Task | What it covers |
|------|----------------|
| `test` | the offline self-test (the recorded fixtures) |
| `test:admin` | the panel's API |
| `test:admin:contract` | every method of the contract answers |
| `test:admin:regression` | the panel's API, end to end |
| `test:admin:login` | the login flows |
| `test:admin:state` | what the panel says about each upstream |
| `test:aggregate` | the published models and the fallback behind them |
| `test:agent` | telling the agents apart by their headers |
| `test:catalog-parity` | the model lists agree with the upstreams |
| `test:config` | the settings, and the hot ones |
| `test:effort` | the thinking levels |
| `test:intern-ai` | 书生·端砚 |
| `test:minimax:checkin` | the MiniMax sign-in |
| `test:qoder:benefits` | the Qoder campaigns |
| `test:route` | the router, end to end |
| `test:session` | the session, and the shared base |
| `test:snapshot` | reading the health snapshot by provider id |
| `test:tokenrhythm` | the tenants, the wallet, the fallback |
| `test:tokenrhythm:fallback` | the fallback between the tenants |
| `test:usage` | the usage log |
| `test:zcode` | the ZCode login window |

None of them spend anything: they run against the mock or the recorded
fixtures.

## Testing

The self-test runs against a mock of the upstreams, so it costs no tokens and
always sees the same answers:

```bash
test/smoke.sh       # the whole matrix against the recorded fixtures
test/aggregate.sh   # the published models and the fallback behind them
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

## The panel

The panel is at `/admin` on the same port as the API. It needs the token in
the data directory (`/data/admin-token`, created on the first start and
printed in the log that one time).

It is meant for the network it runs on. To reach it from outside, put it
behind HTTPS or reach the host over Tailscale — the panel holds the
credentials, so it should not travel in the clear.

### Quota, credits, and the token plan

Three different things, and they are never added together:

| | What it is | Who has it |
|---|---|---|
| **余额 (balance)** | money | the relay stations (TokenRhythm) |
| **积分 (credits)** | points | Qoder, WorkBuddy, SenseNova, InternAI, MiniMax |
| **套餐额度 (token plan)** | a percentage per window (5 hours, weekly) | MiniMax's coding plan, the open platform |

The upstream list shows the token plan when there is one, the credits
otherwise, and the balance separately when there is one. A platform that does
not report a total says so by reporting `0` — the panel leaves that row out
rather than showing a total of zero.

The upstream switches live in the 上游 tab, not in the 配置 tab: one switch,
one place.

### Usage

Every request that reaches an upstream is written down, one row each: when,
which upstream, which model, what the agent asked for, which agent sent it
(pi, opencode, dsh — read from the request headers), which session it belongs
to, which parent session, which sub-agent, which simulated client it went out
through, whether it worked, and how many tokens it used. The 用量 tab
shows the totals (per upstream, per model, per agent, per session, per main
session, per agent name, per day), the detail rows, and a `今日` window that
means "since local midnight" rather than "the last 24 hours".

The main session is the root of the chain: a sub-agent's traffic is rolled
into the main agent's session, and a sub-agent can spawn a sub-agent, so the
chain is walked up to the root. The per-session card shows the ten sessions
with the most traffic.

The "模拟客户端" column says which simulated client the request went out
through — the client's name, not the account: Qoder's global region and its
China region are both "Qoder". Rows written before that column changed meaning
still hold the account id, so the column has both until the old rows age out.

The session comes from the request headers, and the header names say who sent
them:

| what | header | who writes it |
|------|--------|---------------|
| the session | `x-opencode-session-id` | opencode |
| the session | `x-pi-session-id` | the `pi-session-headers` extension |
| the session | `x-session-affinity` | pi itself |
| the parent session | `x-parent-session-id` | neutral — opencode and the pi extension both use it |
| the parent session | `x-opencode-parent-session-id` | opencode |
| the agent's name | `x-agent-name` | neutral — opencode and the pi extension both use it |

A pi sub-agent's own id does not travel by itself: the sub-agent plugin
rewrites `x-session-affinity` to the parent's id so the request keeps hitting
the upstream that holds the parent's prompt cache. The `pi-session-headers`
extension therefore sends the child's id as `x-pi-session-id` (in pi's own
namespace, so pi never writes into opencode's) and the parent's as
`x-parent-session-id`. The agent's name is the only dimension that survives
across runs: a sub-agent gets a fresh session every time.

Requests that never leave the gateway — a model name nobody has, an upstream
that is switched off — are not usage and are not counted. They show up in the
request log instead.

The rows older than `USAGE_RETENTION_DAYS` (30 by default, changeable in the
panel) are dropped at startup and once an hour while it runs.

## Endpoints

| Method | Path | Format |
|--------|------|--------|
| `GET`  | `/v1/models` | OpenAI model list |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream supported) |
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `GET`  | `/health` | status |

Auth: `Authorization: Bearer <key>` (OpenAI) or `x-api-key: <key>` (Anthropic).
Base URL: `http://localhost:6450` (use `.../v1` for OpenAI clients).

Each upstream also has a path of its own — `/qoder/v1`, `/qoder-cn/v1`,
`/workbuddy-cn/v1`, `/minimax/v1`, `/tokenrhythm/v1` — so a client can be
pointed at one upstream, and the model name there is the real one. The root
paths above take the model name with a prefix instead (`qoder-cn/glm-5.3`).

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

## The published models (the root route)

The root route publishes one list of models, and the database decides what is
on it: the panel decides which models exist, what they are called, and which
upstream serves them. With nothing in the database the root route has nothing
to publish and answers 404.

The upstream's own paths (`/qoder/v1`, `/qoder-cn/v1`, `/workbuddy-cn/v1`,
`/minimax/v1`, `/tokenrhythm/v1`) are unaffected: a client pointed at one
upstream keeps the real model names there.

A published model has one or more targets:

| | |
|---|---|
| `single` | everything goes to the first target |
| `fallback` | the first target that answers wins; the ones before it failed |

The fallback is what keeps a model alive when an upstream runs out of credit:
the model is still in the catalog (a catalogue knows nothing about credits),
the request fails on the first target, and the second one answers.

The metadata of a published model comes from its targets, and where the
targets disagree the smallest value wins — the model can only promise what
every one of them can do. The panel can override any of it.

The root route speaks both dialects: a client can ask in the OpenAI shape
(`/v1/chat/completions`) or in the Anthropic one (`/v1/messages`), and the
answer comes back in the same dialect it asked in. The published model name is
the same either way.

| Method | Path | What it does |
|--------|------|--------------|
| `GET`  | `/v1/models` | the published models |
| `POST` | `/v1/chat/completions` | a published model, OpenAI dialect, with the fallback |
| `POST` | `/v1/messages` | the same model, Anthropic dialect |

The panel's own API is Connect over HTTP: `POST /buddy.admin.v1.AdminService/<方法>`,
with the contract in `proto/buddy/admin/v1/admin.proto`. It needs the panel's
own token (`Authorization: Bearer <token>`), which the gateway generates once
into `/data/admin-token` (0600). `/health` stays public.

| Method | What it does |
|--------|--------------|
| `GetSystemStatus` | the upstreams, their credentials, the balances |
| `RestartSystem` | ask the gateway to exit (the container brings it back) |
| `ListUpstreams` / `SetUpstreamEnabled` | the upstream switches |
| `ListConfig` / `SetConfig` | the settings and where each value comes from |
| `ListAccounts` / `ListCredentials` | the accounts and their credentials |
| `TestCredential` / `RefreshCredential` | try one credential, refresh it |
| `LogoutAccount` | log out: delete an account's credentials |
| `GetBalance` | the balances and the credit lots |
| `GetUsageSummary` / `ListUsageEvents` | the traffic |
| `ListPublishedModels` / `SavePublishedModel` / `DeletePublishedModel` | the published models |
| `GetBenefitStatus` / `RunBenefitNow` | the daily check-in |
| `ListModels` | the catalogues of the upstreams |
| `ListProviderKinds` / `AddProvider` / `UpdateProvider` / `DeleteProvider` | the upstreams themselves |
| `SetProviderKeys` | the API keys of an upstream |
| `BeginLogin` / `GetLoginStatus` / `CancelLogin` / `LoginWithPassword` / `ExchangeLoginCode` / `ImportLoginToken` | the logins |
| `TailLog` | the log |

A saved published model takes effect right away: the panel saves what it
changed and the root route serves it from then on.

A published model's metadata may be left out: left out means "whatever the
targets say" (the smallest context window among them, and so on). The gateway
stores that as an empty value, so a panel that reads a model and saves it back
unchanged keeps following the upstreams instead of freezing their numbers.

The settings the panel may change are **hot**: the upstream switches, the
front-door key check and the usage retention take effect on the next request.
The rest is the service's own business and waits for a restart — the panel
does not offer those, and `RestartSystem` asks the gateway to exit (the
container brings it back with the new settings).

The traffic table counts every request against the target that served it, and
against the ones that failed, with the tokens each one cost.

## Reference material

`reference/qoder/` holds what was needed to read the Qoder client's own model
catalogue: the script that decrypts it, the decrypted catalogue, and the
request the client actually sent (decoded). It is what the numbers above are
based on, and it is what to check again when Qoder changes them. It is
local, not in the repository.

`docs/` holds the research material for the other upstreams (the platform
interfaces, the client behaviour, the bug reports). It is local as well.

## Client model lists

The model list carries what a client needs to plan: how much a model reads
(`context_window`) and how much it may answer (`max_output_tokens`).

The output limits are the vendors' own numbers, not the gateway's — the gateway
ignores the `max_tokens` a request asks for and cuts the answer at the model's
own limit. They come from the vendors' model pages: Alibaba Model Studio for
the Qwen family, Moonshot's platform docs for Kimi, Zhipu's model pages for
GLM, DeepSeek's pricing table, MiniMax's documentation.

The context windows are the gateway's own, because those are what the gateway
enforces.

What goes upstream is a separate question, and the answer is the simulated
client's own behaviour — what the Qoder CLI, the MiniMax Code client and the
WorkBuddy app each put in their requests:

| Upstream | The limit it sends |
|---|---|
| Qoder | 32000, whatever the agent asked for — the simulated client's own fallback, its catalogue has no such field |
| MiniMax | the agent's, or the model's own when the agent named none |
| WorkBuddy | the agent's, or the model's own when the agent named none |

The Qoder gateway ignores the number and cuts the answer at the model's real
limit; the WorkBuddy gateway cuts the answer there.

Each upstream is a path of its own, so the model ids are the real ones:

| Provider | Base URL | Upstream |
|---|---|---|
| `qoder_global` | `{router}/qoder/v1` | Qoder, global account |
| `qoder_cn` | `{router}/qoder-cn/v1` | Qoder, China account |
| `workbuddy_cn` | `{router}/workbuddy-cn/v1` | WorkBuddy, China account |
| `minimax_code` | `{router}/minimax/v1` | the MiniMax Code gateway |
| `minimax_api` | `{router}/minimax-api/v1` | the MiniMax open platform, by API key |
| `zcode` | `{router}/zcode/v1` | ZCode (the GLM coding client) |
| `sensenova` | `{router}/sensenova/v1` | SenseNova |
| `intern_ai` | `{router}/intern-ai/v1` | 书生·端砚 (Discovery) |
| `tokenrhythm` | `{router}/tokenrhythm/v1` | the TokenRhythm relay station |

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

## ZCode

ZCode is 智谱's (Z.ai / BigModel) coding client. It is the one upstream whose
credential is a plain browser OAuth: the CLI asks the platform for a flow, the
user approves it in a browser, and the gateway polls for the token.

| Method | Path | Format |
|--------|------|--------|
| `POST` | `/zcode/v1/messages` | Anthropic messages (stream supported) |
| `POST` | `/zcode/v1/chat/completions` | OpenAI chat completions |
| `GET`  | `/zcode/v1/models` | model catalog |

The upstream speaks the Anthropic dialect, so an Anthropic request passes
through; the gateway adds the headers the simulated client sends
(`authorization` and `x-api-key` both carry the token, plus that client's own
identity headers).

**The token cannot be refreshed.** The Z.ai and BigModel adapters do not
implement `refreshToken`, so when it expires the only way back is a new login
in the panel. The panel says so instead of failing quietly.

The models are the built-in table — ZCode keeps them in a static JSON, not
behind an endpoint: `GLM-5.3-Flash`, `GLM-5.2`, `GLM-5-Turbo`.

The quota is the Start Plan's balance: one endpoint returns the buckets, and
each bucket says which models it covers.

The reverse engineering is written up in `docs/zcode/FINDINGS.md` (local, not in
the repository).

## MiniMax open platform

Another upstream of the router, reached through `/minimax-api`: MiniMax's own
platform, not the Code gateway. It is the ordinary OpenAI-compatible API, and
the credential is an API key (`sk-cp-…`, the coding-plan kind).

| Method | Path | Format |
|--------|------|--------|
| `POST` | `/minimax-api/v1/messages` | Anthropic messages (stream supported) |
| `POST` | `/minimax-api/v1/chat/completions` | OpenAI chat completions |
| `GET`  | `/minimax-api/v1/models` | model catalog |

**Several tenants, one key each.** A key is a plan, so several keys are several
plans. They belong to the account, and they are written in the panel: the
account "MiniMax 开放平台" has an "API Key" button; one key per line, the first
line is the first tenant.

The gateway takes the tenants in turn, and a tenant that cannot serve the
request (the plan ran out, the key was refused, the key is rate limited) is
skipped for the next one.

The environment is not a source for keys. It used to be, and it wrote itself
into the database on every read — so a key that was set there survived the
deletion of the account it belonged to, and the key set in the panel was
overwritten by it. A key lives in the account, and deleting the account
deletes the key.

The quota of each tenant is its plan's own windows (five hours and a week) —
the same thing the Code gateway's account has.

## MiniMax Code gateway

One of the router's upstreams: the MiniMax Code LLM gateway, reached through
the router's own `/minimax` path.

| Method | Path | Format |
|--------|------|--------|
| `POST` | `/minimax/v1/messages` | Anthropic messages (stream supported) |
| `GET`  | `/minimax/v1/models` | model catalog |
| `GET`  | `/health` | status, including the account's balance |

The upstream is already an Anthropic `/v1/messages` endpoint, so a request in
the Anthropic dialect passes through verbatim (system, thinking, tools,
streaming) — the router only adds the credential and the attribution headers
the gateway expects. A request in the OpenAI dialect is converted on the way
in and the answer is converted back.

Clients append `/messages` to their base URL, so the base URL is expected to
carry the `/v1` segment — opencode and the Anthropic SDK use `<base>/v1/messages`,
and pi (whose `baseUrl` is a plain root) uses `<base>/v1/messages` as well.

What makes the gateway treat this as a MiniMax Code client is the OAuth grant
itself — `client_id=mcode-public`, `audience=agent-backend`, `scope=agent.default`
— not a header trick. The token read from the desktop app's store is already a
MiniMax Code credential.

### Credential

Two sources, picked by `MINIMAX_AUTH_MODE` (`lib/minimax/auth.ts` dispatches):

**`oauth`** (default, required in Docker) — the proxy owns its own session:

- The proxy logs itself in: with no session file it runs the device flow at
  startup, printing an authorization URL and a user code. You approve in a
  browser and the credential is written as a single JSON file
  (`~/.minimax-proxy/minimax-session.json`, or `/data/minimax-session.json` in
  the container). The server keeps serving while you approve, so a request in
  the meantime gets a clear 503 rather than a hang.
- This only happens when the upstream is switched on (the panel's 上游 tab). A
  disabled upstream never looks for a credential at all.
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
`GET /v1/models` is served from a local catalog (`lib/minimax/models.ts`):

| id | context | max output | notes |
|----|---------|------------|-------|
| `MiniMax-M3.1-Flash` | 1,000,000 | 128,000 | default |
| `MiniMax-M3` | 1,000,000 | 128,000 | |

The limits follow the desktop app's own config (`limit.output: 128000`,
`defaultModelContextWindow: 1000000`); models.dev reports 512k output instead,
and the simulated client picks the lower one on purpose so a planned response
is never cut. The gateway validates neither number up front, so both are advisory
budgeting values.

The gateway does **not** validate model ids either: an unrecognized name (say
`MiniMax-M3.1`) is silently routed to `MiniMax-M3` instead of failing. The
`model` field in the response tells you what actually ran.

### Clients

- **pi** — `~/.pi/agent/models.json` has a `minimax_code` provider
  (`baseUrl: http://<proxy-host>:6450/minimax`, `api: anthropic-messages`)
  listing both
  models with `contextWindow: 1000000` / `maxTokens: 128000`, a
  `thinkingLevelMap` (pi's `off|minimal|low|…|max` → the gateway's effort
  values) and `compat.forceAdaptiveThinking: true`, so pi sends the same
  `thinking: {type: "adaptive"}` + `output_config: {effort: …}` the desktop
  client sends. Pick a level with `pi --model MiniMax-M3.1-Flash:high`.
  `compat.sendSessionAffinityHeaders: true` puts the session id in the
  `x-session-affinity` header, which is how the panel tells one session from
  another.
- **opencode** — `~/.config/opencode/opencode.jsonc` has a `minimax_code`
  provider (`npm: @ai-sdk/anthropic`, `baseURL: http://<proxy-host>:6450/minimax/v1`)
  with the same two models and limits. The thinking levels are declared as
  `capabilities.reasoning.effort` — opencode turns that into model variants
  (`low`/`medium`/`high`/`xhigh`/`max`), selectable as
  `opencode run -m minimax_code/MiniMax-M3.1-Flash#high`. Hand-written
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

The gateway logs the outcome of every streamed response (`[RES] … done 1234ms
bytes=… pings=…`, or `FAILED after … cause=…`), which is what tells an upstream
failure apart from a connection dropped by a hop in front of the proxy.

### Heartbeat

The gateway sends one `event: ping` right after `message_start` and then stays
silent for as long as the model thinks — a long thinking pause can keep the
stream quiet for minutes. Any hop in front of the proxy (a local HTTP proxy, a
NAT gateway) may drop such an idle connection. The proxy therefore sends its
own `event: ping` when the stream has been quiet for `MINIMAX_PING_MS`
(default 15s), using the same payload the gateway uses, so clients ignore it.

A ping is only written on an SSE frame boundary — writing one in the middle of
an upstream frame would corrupt the agent's parse — and only when the stream
is actually idle, so a busy stream is not padded with useless events.

### Environment

| Variable | Default | What |
|----------|---------|------|
| `MINIMAX_AUTH_DIR` | auto-detected | credential store directory |
| `MINIMAX_REGION` | `cn` | store subdirectory (`cn` / `global`) |
| `MINIMAX_CLIENT_ID` | `mcode-public` | OAuth client id |
| `MINIMAX_AUTH_CACHE_MS` | `5000` | how long a read of the store is reused |
| `MINIMAX_AUTH_WARN_MS` | `600000` | warning window before expiry |
| `MINIMAX_WATCH_MS` | `300000` | background watch interval |
| `MINIMAX_ATTRIBUTION_HEADERS` | `true` | send the simulated client's attribution headers |
| `MINIMAX_USER_AGENT` | `MiniMaxCode` | User-Agent sent upstream |
| `MINIMAX_ANTHROPIC_VERSION` | `2023-06-01` | `anthropic-version` sent upstream |
| `MINIMAX_BASE_URL` | `https://agent.minimax.cn/mavis/api/v1/llm/v1` | gateway base URL |
| `REQUIRE_API_KEY` | `false` | enforce `api-keys.json` keys |
| `MINIMAX_AUTH_MODE` | `oauth` | `oauth` (proxy's own session) or `file` (read-only app store) |
| `MINIMAX_PING_MS` | `15000` | SSE heartbeat: send `event: ping` when the stream has been quiet this long (`0` disables) |
| `MINIMAX_REFRESH_BUFFER_MS` | `300000` | refresh this far before expiry |
| `MINIMAX_API_BASE` | `https://api.minimax.cn` | the platform the balance is read from |
| `MINIMAX_TOKEN_PLAN_KEY` | — | removed: the token plan's key belongs to the account, not to the environment |

### Credentials

Every secret the gateway holds is in one SQLite file: the sessions of the four
clients, the keys the agents authenticate with, the relay station's accounts
and the salt the device fingerprint is derived from.

One directory holds all of it — the database, the credential log and the salt:

| Variable | Default | What |
|----------|---------|------|
| `BUDDY_DATA_DIR` | `/data` (`~/.buddy-proxy` outside Docker) | the directory: `buddy.db`, `auth.log`, `identity.salt` |

```bash
# what is in there
node router-proxy.ts --clear            # lists the credentials
# forget one, so that the next start logs in again
node router-proxy.ts --clear session:qoder:cn
```

The file is 0600 and lives in the data volume. The refresh tokens rotate on
every refresh, so only one holder of a session can refresh it — the database
holds a lock for that, the same way the lock file used to.

### How the sessions stay alive

The official clients refresh their own tokens on a timer; nobody presses a
button. The gateway does the same: a timer (every minute) looks at each
session and swaps the token before it expires (`lib/session-refresh.ts`; each
kind says how its own session is refreshed). A request never waits for a
refresh, and the panel has no "refresh" button — a session that the platform
refused is dead, and the way back is to authorize again.

One session, one holder. The refresh token rotates on every refresh, so the
old one dies immediately, and the platform withdraws **every** session of that
account when it sees an old token used again. So a copy of the database
running somewhere else is a second holder: it refreshes, and the copy here
stops working. The same is true of the desktop client's own store — it must
not keep a session of an account the gateway holds.

### Health

`/health` does not ask the upstreams. The live part — the account standing,
the credits, the balances — is fetched in the background and kept in the
database; the endpoint answers with the last known state and says how old it
is.

| Variable | Default | What |
|----------|---------|------|
| `HEALTH_CACHE_MS` | `300000` | how long the live part stays good |

## Router (`router-proxy.ts`, port 6450)

One entry point, two dialects, nine upstreams. The model name decides the
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

The upstream switches are in the `providers` section — one entry per
provider, with its id, name, kind and whether it is on. A provider you added
yourself is in there too; the built-in list of nine is not written out
anywhere. (This section used to be `enabled.<camelCase>`; the `providers`
section carries the same facts and the ones you added.)

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
exceeded". They stay in `lib/qoder/models.ts` for the CN region, which does run
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
keeps the plain name, and the model id the upstream sees is unchanged, so
nothing about the wire format depends on it.

The tool round trip needs one extra thing on the legacy protocol: the request
has to carry the assistant's tool calls and the tool's answer inside
`response_meta`, or the model cannot tell that it already made the call and
calls the tool again — forever. `lib/qoder/legacy.ts` puts them there in the
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
# flow at startup and prints the URL to approve. Switch the region on in the
# panel first (上游 tab).
node router-proxy.ts   # qoder.com and qoder.cn, whichever is switched on
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
| `MINIMAX_BASE_URL` | the gateway's own address | where the MiniMax gateway is |
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
reproduces that shape (`lib/workbuddy/auth.ts`).

Two things are not what they look like:

- **The upstream always answers with a stream**, even for a client that asked
  for none. A non-streaming request is folded back into one completion object
  here.
- **The catalogue comes from the upstream** at `GET /v3/config`, and the
  upstream adds models without a client release. The proxy fetches it at
  startup and then keeps it for three quarters of an hour, and falls back to
  the last good one when the server cannot be reached. The bundled snapshot is
  only the fallback.

The identity around the request is the simulated client's, taken from a request
that client actually made: the product version in the user agent (the command
line client's own version, not the desktop app's), the account headers, the
agent and IDE headers, the seven `x-stainless-*` headers the OpenAI Node SDK
adds, the trace family, and the identifiers in the shape that client uses (a
uuid v7, dashed for the conversation and plain for the requests). The headers
it does not send are not sent here either.

The request is built the way the simulated client builds it, not by passing the
caller's parameters through:

- the thinking level is clamped to the ones the model accepts, downwards;
- a model that cannot call tools is sent no tools;
- the temperature and the top_p are the model's own, unless the caller chose
  them;
- a model that thinks is also asked for a summary of its thinking and for a
  verbose answer (`reasoning_summary: "auto"` and `verbosity: "high"`), which
  is what the simulated client sends and what the product gateway keeps;
- the conversation keeps one id for all its turns, so the upstream sees the
  turns as one conversation instead of a new one each time.

The identity around the request is the simulated client's: the product version
in the user agent, the account headers, the agent and IDE headers, the trace
family, and the identifiers in the shape that client checks (a lowercase
UUIDv7). The headers it does not send are not sent here either.

`docs/workbuddy/DIVERGENCES.md` and `docs/workbuddy/FINDINGS-LINUX.md` (local,
not in the repository) list every difference between this and the official
client that the review found, with the evidence for it.

### Login

The login is the browser one: the proxy asks for a state, sends you to
`https://www.workbuddy.cn/login`, and polls until you approve. The token is a
JWT whose `sub` claim is the account id. The refresh token rotates on every
refresh, so the session file must survive restarts.

```bash
node router-proxy.ts   # prints the login URL, once WorkBuddy is switched on
```

### Models

19 models as of 2026-10-22, from `hy3` and `step-5-preview` (free) through
`kimi-k3-1` (the most expensive). The label carries the credit multiplier, so
the list reads as a price list: `Hy3 免费`, `GLM-5.3-Flash 0.08×`,
`Kimi-K3 1.62×`. The paid build of a name is listed next to the free one, the
way the official picker shows it (`hy3` and `hy3-x`).

`glm-5.1` is in the upstream's own catalogue but every request for it is
rejected with code 11133, so it is left out.

### Environment

| Variable | Default | What |
|----------|---------|------|
| `WORKBUDDY_CN_BASE` | `https://www.workbuddy.cn` | the host that serves the account |
| `WORKBUDDY_CLI_VERSION` | `2.161.0` | the version the identity headers claim (the CLI's own) |
| `WORKBUDDY_VERSION` | `5.8.3` | the version of the desktop app |
| `WORKBUDDY_AUTH_PLATFORM` | `workbuddy` | the platform the login asks about |
| `WORKBUDDY_CATALOG_TTL_MS` | `1800000` | how long the upstream's catalogue is trusted |
| `WORKBUDDY_REFRESH_BUFFER_MS` | `86400000` | refresh this far before expiry |
| `WORKBUDDY_AUTH_WARN_MS` | `604800000` | warning window before expiry |
| `WORKBUDDY_LOGIN_TIMEOUT_MS` | `600000` | how long to wait for the browser approval |

## TokenRhythm (the relay station)

TokenRhythm is a relay station: the models are other people's, the account
holds the money, and the platform speaks the OpenAI dialect — so there is
nothing private to reverse here. What the gateway adds is the part a relay
does not do: it keeps several accounts and spends them in the right order.

### The accounts

Each account is a set of environment variables, and there can be many:

```bash
TOKEN_RHYTHM_1_ACCOUNT=...
TOKEN_RHYTHM_1_PASSWORD=...
TOKEN_RHYTHM_1_API_KEY=sk_tr_...
```

The account and the password are for the **wallet**: the proxy logs in with
them, keeps the session cookie on this machine, and reads the balance. The key
is for the **inference**. The two are different things on the platform — the
key cannot read the wallet (every balance endpoint answers 401 for it), and
the session cannot call the models.

A key is shown in full once, in the answer to the call that creates it, so a
new account has no way to get one on its own. The gateway makes its own and
keeps it next to the account: log in, create a key, store it. So
`TOKEN_RHYTHM_<n>_API_KEY` is only needed to bring a key **you** made — one
the environment names wins over the one the gateway made.

Making a key is a write, and the platform checks three things on a write: the
session cookie, the CSRF token sent twice — once as the `tr_csrf` cookie and
once as the `X-CSRF-Token` header — and the browser's `Sec-Fetch-Site:
same-origin`, which a script has to say for itself. Without a key the account
still shows its balance, it just cannot serve a request.

### Which account pays

The gift money expires, the money that was paid for does not. So a request
goes to the account whose gift runs out first, and the account with only paid
money is the last resort. That is the upstream's **余额到期优先** policy, and it
is the one the panel sets by default for this relay station; the other policies
are 单一 (one account, no switching) and 降级 (try the next account when one
cannot serve the request). The balance and the expiry of every account are in
`/health`:

```json
{
  "index": 1,
  "account": "175***32",
  "hasKey": true,
  "wallet": { "availableCny": 100.43, "giftAvailableCny": 50.43, "rechargeCny": 50 },
  "credits": {
    "summary": { "expiringCny": 50.43, "nextExpiryAt": "2026-11-19T04:28:10.883Z" },
    "list": [
      { "sourceLabel": "充值活动赠额", "remainingCny": 50, "expiresAt": "2099-12-31T15:59:59.000Z" },
      { "sourceLabel": "实名认证奖励", "remainingCny": 0.43, "expiresAt": "2026-11-19T04:28:10.883Z" }
    ]
  }
}
```

The list is the truth and is there to be read: every lot, with the date the
platform gives it.

The summary is the platform's own view, and its amount is not to be trusted —
it counts the money that never expires as money that runs out, so an account
that holds fifty permanent credits and forty cents that expires reads as if
all of it expires on the same day. Its `nextExpiryAt` is the useful part: it
points at the gift that runs out first, and it moves on when that gift is
spent, which is how the gateway knows to change account.

### When the relay is busy

The relay answers `503 SERVICE_BUSY` when its backends are all taken. That is
a temporary state of the upstream, not a broken request, so the gateway tries
the same account again — **not another account**: another account would have
to read the prompt from the start, and the relay charges the uncached prompt,
which is a lot more than the answer itself.

After the attempts are used up the agent gets a `503` with the upstream's own
trace id, and the answer can simply be tried again.

| Variable | Default | What |
|----------|---------|------|
| `TOKENRHYTHM_MAX_ATTEMPTS` | `3` | how often a busy relay is tried again, on the same account |

### The thinking rule

DeepSeek's thinking mode wants the assistant's `reasoning_content` back when
the request ends with a tool result — even an empty string. A client that
switched models mid-conversation leaves the field out, and the upstream
answers 400. The gateway puts it back (`lib/tokenrhythm/transport.ts`).

### Models

One model for now: `deepseek-v4.1-flash-1017`, a million tokens of context and
384000 of output.

### Environment

| Variable | Default | What |
|----------|---------|------|
| `TOKEN_RHYTHM_<n>_ACCOUNT` | — | the account of the nth tenant |
| `TOKEN_RHYTHM_<n>_PASSWORD` | — | its password |
| `TOKEN_RHYTHM_<n>_API_KEY` | — | the key its inference uses |
| `TOKENRHYTHM_API_BASE` | `https://tokenrhythm.studio` | the platform |
| `TOKENRHYTHM_INFER_BASE` | `{api}/v1` | where the models are called |

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

Every account hands out credits for showing up, and the router takes them
without being asked. It runs when it starts and then every hour; the day
rolls over at midnight in China, and every call is idempotent — asking twice
answers "already done" rather than doing it again.

| Account | What it takes |
|---|---|
| MiniMax Code | the sign-in (`/minimax-cloud/api/v1/signin/status` and `/claim`) — seven days, the first day worth more |
| WorkBuddy | the daily check-in (`/v2/billing/meter/daily-checkin`), and then the growth centre: the gift the travelling Buddy brings back, the tasks, the make-up cards for a missed day, the streak tier, and the blind box |
| Qoder (both regions) | the campaigns (`/sash/api/v1/me/campaigns`) that are claimable |

The Qoder activity service is the same service in both regions — only the host
differs — so the global account is checked in the same way as the China one.

The WorkBuddy growth centre is a chain of calls: take the gift, send the Buddy
out again so there is one to collect tomorrow, accept the tasks that are not
accepted, claim the ones that are finished, use a make-up card for a day that
was missed, redeem the tier the streak unlocked, and open one blind box. A
draw cannot be undone, so only one is opened per run.

The Qoder campaigns come back **empty** when the request says it is the
command-line client (`Cosy-ClientType: 5`): the daily credits are the desktop
client's promotion, so the request has to say it is the desktop client
(`Cosy-ClientType: 10`). The machine identity makes no difference to this —
sending a real one, a made-up one, or none at all gives the same list — so
the gateway sends none of them.

The result of the last run is in `/health` under `benefits`:

```json
"benefits": {
  "enabled": true,
  "intervalMs": 3600000,
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

### What is left

The balance is in `/health`, per account. Every upstream has its own way of
answering:

| Upstream | Where the numbers come from |
|----------|-----------------------------|
| MiniMax | the account balance (`/account/query_balance`), the plan's own windows (`/v1/token_plan/remains`, needs the plan key) and the points (`/minimax-cloud/api/v1/credit/details`) |
| Qoder | the plan's credits and the ones bought on top (`/api/v2/quota/usage`) |
| WorkBuddy | the check-in status, which carries the daily and the total |
| TokenRhythm | the wallet and the gift that expires (`/api/wallet/summary`, `/api/wallet/expiring-credits`) |
| SenseNova | the pools of the console (`/lite/console/v1/tokenplan/pool-usage`) |
| ZCode | the Start Plan's buckets |
| 书生·端砚 | the balance and the packs of the console |

The three kinds of number are never added together: the balance is money, the
credits are points, and the plan is a percentage per window. A platform that
does not report a total says so by reporting `0`.

The MiniMax plan runs in two windows — five hours and a week — and what is
left of each is a percentage. The plan's key is the API key (`sk-cp-…`), not
the OAuth session the Code gateway uses, so it is a credential of its own: it
is written in the panel, on the account row, next to the other keys. The plan's
usage is left out when the account has no plan key.

The Qoder numbers look like this:

```json
"credits": {
  "region": "global",
  "plan": { "total": 300, "used": 22, "remaining": 278 },
  "addOn": { "total": 100, "used": 0, "remaining": 100 },
  "quotaExceeded": false,
  "resetsAt": "2026-11-03T07:28:22.099Z"
}
```

| Variable | Default | What |
|----------|---------|------|
| `BENEFITS_INTERVAL_MS` | `3600000` | how often the check-in runs |

## Deployment (Docker)

The image carries the code. The NAS never receives a checkout — it holds a
`docker-compose.yml` and a `./data` directory, and nothing else. The image is
built locally and shipped there as a tar.

The compose file runs one service from that one image: the router on 6450.

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

The login is the only step that needs a human, and the service does it
itself: a switched-on proxy with no session runs the device flow at startup
and prints the authorization URL and user code to its log. Approve it in a
browser and the credential lands in the database. Every later refresh is done
by the proxy itself. To log in again, log out in the panel (that deletes the
credential) and restart.

```bash
docker compose logs -f          # the authorization URL shows up here
```

`./data` must survive rebuilds — the refresh token rotates on every refresh, so a
lost database means logging in again.

The script that does the whole thing (build, ship, replace, and the credential
migration) is `tools/deploy-nas.sh`, in the local `tools/` directory.
