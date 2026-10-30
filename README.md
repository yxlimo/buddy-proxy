# buddy-proxy

One gateway in front of eleven model platforms. It answers in the OpenAI
dialect and in the Anthropic dialect on the same port, and it sends every
request out in the shape that platform's own desktop client sends it — so a
platform that only answers its own client still answers here.

One process. One port (`6450`). One data directory.

## What you get

- **Eleven platforms behind one URL.** MiniMax Code, ZCode, Qoder (the global
  region and the China one), WorkBuddy (China and international), TokenRhythm,
  SenseNova, 书生·端砚, 七牛云, 讯飞星火.
- **Several accounts per platform.** An account is one login; a platform can
  hold many of them, and each has its own switch and its own weight.
- **Another account takes over when one cannot serve.** A platform whose policy
  is 降级 (fallback) moves on to the next account when the current one is out
  of quota, cooling down after a failure, or not logged in.
- **Weight decides who is tried first.** Inside a platform, the account with
  the higher weight is tried first.
- **A spent account does not delete a model.** The model stays in the list; the
  request comes back 503 with the time it will recover, not 404.
- **One published list on the root route.** A model published there can point at
  several upstreams, and the panel shows which one is serving and how the
  traffic is split.
- **Both dialects, both ways.** OpenAI and Anthropic requests are accepted on
  the root route and on every platform route, streaming or not; tool calls and
  the thinking channel are converted in both directions.
- **A panel that shows the numbers.** Quota, credits and balance per account,
  the usage of every request, the published models, the logins.
- **The daily credits are taken for you.** The accounts that hand out credits
  for showing up are checked in automatically.

## Install and run

### With Docker

The image carries the gateway and the panel.

```bash
# build the image (the panel is built into it)
podman build --format docker -t buddy-proxy:latest .    # or: docker build -t buddy-proxy:latest .

# run it: one process, one port, one data directory
podman run -d --name buddy-proxy \
  -p 6450:6450 \
  -v "$PWD/data:/data" \
  buddy-proxy:latest
```

`./data` is the volume the service works in. It has to survive a rebuild: it
holds the sessions, and a lost session means logging in again.

#### With docker compose

The same image, run by compose:

```yaml
services:
  buddy-proxy:
    image: shaylulimo/buddy-proxy:0.2.1
    container_name: buddy-proxy
    restart: unless-stopped
    ports:
      - "6450:6450"
    volumes:
      # /data has to be persistent: the sessions live in it, and a lost
      # session means logging in again.
      - ./data:/data
    environment:
      ROUTER_PORT: "6450"
      BUDDY_DATA_DIR: /data
```

```bash
docker compose up -d
docker compose logs -f
xdg-open http://localhost:6450/admin/    # the panel (on macOS: open)
```

The service answers on `http://<host>:6450`, and the panel is at
`http://<host>:6450/admin/`. Sign in with the token in `./data/admin-token` —
it is written on the first start.

The service starts with no account enabled and waits for you to say which ones
to serve.

### With node

```bash
mise install      # the tool versions this project expects
pnpm install      # the dependencies
mise run serve    # node router-proxy.ts, on http://localhost:6450
```

### The data directory

Everything the service keeps lives in one directory, `BUDDY_DATA_DIR`:

| | |
|---|---|
| `buddy.db` | the accounts, their credentials, the settings, the published models, the usage |
| `admin-token` | the panel's own token, written on the first start |
| `auth.log` | the log of the credential events (logins, refreshes) |
| `identity.salt` | the fingerprint salt of an older installation — read once so the fingerprint does not change; the salt itself now lives in the database |

In Docker it is `/data`; outside it is `~/.buddy-proxy`. Back it up: it is the
whole installation.

## The first time

1. Start the service.
2. Open `http://<host>:6450/admin/`.
3. Sign in with the token in `<BUDDY_DATA_DIR>/admin-token`. It is created on
   the first start and printed in the log that one time.
4. The panel is meant for the network it runs on: it holds the credentials, so
   reach it over a private network or behind HTTPS, not over the open internet.
5. Go to the 上游 tab, pick a platform, and add an account. The panel draws the
   login form the platform needs — a device code, a browser approval, a
   password, or an API key.
6. Switch the account on. Every account starts off; an account that is off is
   never read, and no login is attempted for it.
7. Set the platform's policy in the same tab: 单一 (single, no switching),
   降级 (fallback), and — for TokenRhythm — 余额到期优先 (the account whose
   gift money runs out first is used first). The policy belongs to the
   platform, because it says how that platform's accounts take turns.
8. Check the 额度 and 用量 tabs: what is left on each account, and what the
   traffic looks like.

The platform's own path (`/qoder-cn/v1`, `/minimax/v1`, …) is unaffected by
anything you publish on the root route, so a client pointed at one platform
keeps working with that platform's own model names.

## Point a client at it

### The root route

The platform is part of the model id:

```text
base url : http://<host>:6450/v1
model    : qoder-cn/glm-5.3
```

### A platform route

The model id is the platform's own:

```text
base url : http://<host>:6450/qoder-cn/v1
model    : glm-5.3
```

The two spellings mean the same thing; the second one is the shorter way to
say the first.

### An OpenAI client

```text
base_url = "http://<host>:6450/v1"
api_key  = "<the deployment's key>"
model    = "qoder-cn/glm-5.3"
```

### An Anthropic client

The Anthropic SDK appends `/v1/messages` to the base url, so the base url is
the plain root:

```text
base_url = "http://<host>:6450"
api_key  = "<the deployment's key>"
model    = "qoder-cn/glm-5.3"
```

The key goes in `Authorization: Bearer <key>` for the OpenAI dialect and in
`x-api-key: <key>` for the Anthropic one. The gateway does not check the key
unless the deployment asks it to, so a fresh installation accepts anything.

### With curl

```bash
# OpenAI dialect
curl http://localhost:6450/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"qoder-cn/glm-5.3","messages":[{"role":"user","content":"hi"}]}'

# Anthropic dialect
curl http://localhost:6450/v1/messages \
  -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"model":"qoder-cn/glm-5.3","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

### The model list

| Method | Path | What |
|--------|------|------|
| `GET` | `/v1/models` | the models on the root route — the ones published in the panel |
| `GET` | `/{platform}/v1/models` | one platform's own catalogue, with the plain model ids |
| `GET` | `/health` | the state of every enabled platform |

`/v1/models` takes `?dialect=openai` for the OpenAI shape; the default is the
Anthropic one.

The root route publishes exactly what the panel publishes: a model you publish
on the 主路由模型 page is served there, with the name you gave it. A model that
is in the panel but not published — its upstream is off, not logged in, or the
model is gone upstream — is left out, and the panel says why.

## The platforms

Each region is a platform of its own and needs its own login.

| Path id | What it is | How you log in |
|---------|------------|----------------|
| `minimax` | MiniMax Code, the coding gateway of MiniMax | device code: open a URL, type the code |
| `zcode` | ZCode, Zhipu's (Z.ai) GLM coding client | browser OAuth |
| `qoder` | Qoder, global region (qoder.com) | approve the device flow in a browser |
| `qoder-cn` | Qoder, China region (qoder.cn) | approve the device flow in a browser |
| `workbuddy-cn` | WorkBuddy, China region (workbuddy.cn) | browser login |
| `workbuddy-global` | WorkBuddy, international region (workbuddy.ai) | browser login |
| `tokenrhythm` | TokenRhythm, a relay station with paid accounts | account and password (the wallet) |
| `sensenova` | SenseNova | account and password |
| `intern-ai` | 书生·端砚, InternAI's Discovery site | browser SSO, then import the uaa-token |
| `qiniu` | 七牛云 | API key (the inference key and the console cookie) |
| `xinghuo` | 讯飞星火 | API key |

A platform can hold several accounts: two MiniMax Code subscriptions, one
tenant each on the relay station, one account per API key on the key-only
platforms. The platform's policy decides which of its accounts takes a request.

## The daily credits

Several platforms hand out credits for showing up — MiniMax's sign-in,
WorkBuddy's check-in and growth centre, Qoder's campaigns. The gateway claims
them for you: once when it starts and then every hour. Asking twice on the
same day is a no-op, so a restart does not cost you the day's credits. A
platform that is switched off is not asked at all.

The result of the last run is in `/health` and in the panel's 额度 tab.

## What the panel shows

| Tab | What it is for |
|-----|----------------|
| 上游 | the platforms, their accounts, the switches, the logins, the policy |
| 额度 | the quota, the credits and the balance, per account |
| 用量 | the totals and the rows of every request that reached an upstream |
| 主路由模型 | the models published on the root route and their targets |
| 配置 | the settings, and where each value comes from |

The panel also tails the service log.

### Quota, credits and balance

Three different things, and they are never added together:

| | What it is | Where it comes from |
|---|---|---|
| 套餐额度 | a percentage per window (five hours, a week) | the coding plans |
| 积分 | points | the platforms that give out points |
| 余额 | money | the relay stations |

The panel shows the plan quota when the platform reports one, the credits
otherwise, and the balance on its own. A platform that reports no total is
left out rather than shown as zero.

### Usage

Every request that reaches an upstream is written down: when, which upstream,
which model, which account served it, which agent sent it, whether it worked,
and how many tokens it cost. The 用量 tab shows the totals per upstream, per
model, per agent and per day, plus the rows themselves. A request that never
left the gateway — a model nobody has, an upstream that is switched off — is
not usage and is not counted; it shows up in the request log instead.

## Endpoints

| Method | Path | Format |
|--------|------|--------|
| `GET` | `/v1/models` | the models on the root route (`?dialect=openai` for the OpenAI shape) |
| `GET` | `/{platform}/v1/models` | one platform's own catalogue |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream supported) |
| `POST` | `/{platform}/v1/chat/completions` | the same, addressed to one platform |
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `POST` | `/{platform}/v1/messages` | the same, addressed to one platform |
| `GET` | `/health` | the state of every enabled platform |

`{platform}` is one of the ids in the table above.

## The three settings you may want to change

| Variable | Default | What |
|----------|---------|------|
| `BUDDY_DATA_DIR` | `/data` in Docker, `~/.buddy-proxy` outside it | where the database, the panel token, the credential log and the fingerprint salt live |
| `ROUTER_PORT` | `6450` | the port the gateway listens on |
| `PERIODIC_ENABLED` | `true` | the background timer: refresh the tokens before they expire, take the daily credits, scan the balances. `false` turns all of it off |

The rest of the settings are changed in the panel, not in the environment.

`PERIODIC_ENABLED=false` is the one to know about: with it off, the service
never touches a login state — no refresh, no check-in, no balance scan. Use it
while you are debugging, or when the official desktop client should be the
only holder of an account. It is read once at startup, so a change needs a
restart.

## FAQ

### 429 or 503 says no account of this platform can serve right now

The gateway tried the accounts of that platform and none could take the
request: out of quota, cooling down after a failure, or not logged in. Open
`/health` or the panel's 上游 tab — it says which account and until when. Then
either add or switch on another account for that platform, or wait for the
cooldown to end.

### The quota looks fine, but the requests fail

Check which account the platform's policy picks: the heavier account may be
the one that is exhausted, and the fallback only starts after it fails. The
request log in the panel keeps the upstream's own answer, not just the status
code, so it says what the platform actually refused. The 用量 tab shows which
account served each request and which ones failed.

### An account was logged in somewhere else, and now it fails

A session has exactly one holder. The refresh token is replaced on every
refresh, and the platform withdraws every session of that account as soon as
it sees an old token used again. So a second copy of the gateway on the same
account — or the official desktop client holding the same session — breaks it.
Log the account out in the panel and log in again.

### Why are the quota, the credits and the balance three separate numbers?

They are three different things: a percentage of a window, points, and money.
Adding them would mean nothing, so the panel keeps them apart — the plan
quota when there is one, the credits otherwise, the balance on its own.

### A model disappeared from the list

On the root route, the list is what the panel publishes: check the 主路由模型
page, which also says why a model is not published (the upstream is off, not
logged in, or the model is gone upstream). On a platform route, the catalogue
is the platform's own — an account that is out of quota does not remove models
from it. In some clients the picker groups the models under Favorites and
Recent, so a model that "disappeared" may be listed above instead.

### The service asks me to log in again after a restart

The sessions live in the data directory. If that directory was wiped — a new
volume, a container started without the mount — the accounts have no session
and have to be logged in again. Mount one directory and keep it.

### Can I run two instances on the same account?

No. A session has one holder (see above), and the platform revokes the whole
account's sessions when it sees a replayed token. Give each instance its own
accounts.
