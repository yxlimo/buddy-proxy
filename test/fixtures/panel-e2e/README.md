# Recorded upstream answers for the panel's browser tests

These are real answers, recorded from the live upstreams on **2026-11-12** and then
scrubbed. The values are synthetic; the *shape* is not.

They exist because three answers a panel test needs cannot be invented without
guessing at something only the upstream decides:

- a model being **parked in a queue** (Qoder) — the gateway has a whole path for
  it (`QueuedError`: a failure the router moves on from, and one it does not blame
  the account for);
- the **login start** of each device-code / browser flow — what the panel shows
  the operator, and what an unapproved login says to the upstream;
- an open platform's **model catalogue**, which is what "refresh the model
  catalogue" fetches.

Nothing here was produced by hand. Each file is the answer one request returned,
kept verbatim apart from the scrubbing listed below.

Recording date: 2026-11-12. Recorder: `tools/record-panel-fixtures.ts` (see the
end of this file).

## The files

| Fixture | Endpoint | The lib code that sends and reads it | Why it is needed | Cost of the request |
| --- | --- | --- | --- | --- |
| `qoder-queue-frame.json` | `POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation` (China region; `api2.qoder.sh` is the global host) | `lib/qoder/legacy.ts` `legacyChatCompletion` + `readLegacyFrames`; `lib/router/upstreams/qoder.ts` `isRetryableLegacy` / `legacyWaitMs` / `queueExhausted`; `lib/qoder/queue.ts` `parseLimitError` | The queue answer only exists when the upstream has no slot for the model — no fake upstream produces it faithfully, and it is the one answer the queue path is for | 0 tokens. `deepseek-flash` (`dfmodel`) is a 0× model, the stream was cancelled after the first frame, and a queued request generates nothing |
| `minimax-device-code.json` | `POST https://account.minimax.cn/oauth2/device/code` | `lib/minimax/oauth.ts` `startDeviceAuthorization` | The panel's "log in" for MiniMax shows a code and a link, both parsed out of this answer | free (no account touched) |
| `qoder-login-poll-pending.json` | `GET https://openapi.qoder.com.cn/api/v1/deviceToken/poll` (China region) | `lib/qoder/auth.ts` `buildDeviceAuthorization` + `pollDeviceTokenOnce` | "Still waiting for the user" is a **404 by design** for Qoder, and that is the only upstream answer its login has before approval. See the note below on why there is no device code here | free |
| `workbuddy-login-start.json` | `POST https://www.workbuddy.cn/v2/plugin/auth/state?platform=workbuddy` | `lib/workbuddy/auth.ts` `startLogin` | The panel's "log in" for WorkBuddy shows a link built from `data.authUrl`, and the state is what the poll later sends | free |
| `zcode-login-start.json` | `POST https://zcode.z.ai/api/v1/oauth/cli/init` | `lib/zcode/auth.ts` `beginLogin` | The panel's "log in" for ZCode; and `expires_at` is the field where seconds-versus-milliseconds goes wrong (the lib treats a value under 1e11 as seconds) | free |
| `catalog-models.json` | `GET https://api.qnaigc.com/v1/models` (Qiniu / 七牛云) | `lib/open-platform-catalog.ts` `fetchOpenPlatformModels` + `parseModelList` + `traitsFromEntry` | "Refresh the model catalogue" is a panel button that reaches a real upstream address; this is the answer it parses | free (a GET of a published list) |

Seven requests were sent in total, and six of them produced these files. The
seventh was a first attempt at the WorkBuddy login: it went out before the
recorder could see it (that endpoint is sent through `cliFetch` over `node:http`,
not `fetch`), so it was made again after the recorder learned to watch that
transport. Everything left the host through the recorder; nothing was sent by hand.

### Why there is no `qoder-device-code.json`

Qoder has no device-code endpoint. Its login start is computed locally — the PKCE
challenge and the nonce — and the user is sent to
`https://…/device/selectAccounts?…` with them (see `buildDeviceAuthorization` in
`lib/qoder/auth.ts`). There is no upstream answer to record, so recording one
would have meant inventing it and calling it real.

What was recorded instead is the answer the flow *does* get from the upstream: the
poll's `404`, which the lib reads as "still waiting". It is a real answer from the
real endpoint, it is free, and it is the branch a panel test would sit in while the
operator has not approved yet.

## What was washed

Every fixture keeps its field names and its types, and keeps a value's length
wherever a parser branches on it (a 43-character device code is a different branch
from a 12-character one). What changed:

| Fixture | Replaced | Kept |
| --- | --- | --- |
| all six | every response header except `content-type` (and `retry-after` when present, with its seconds replaced) — the rest are request ids, trace ids, cache uuids and session cookies | — |
| all six | the request URL's query values that were handed out to this account (nonces, verifiers, states, user codes, client ids) | the query keys, and the parameters that say what was asked for (`FetchKeys`, `AgentId`, `Encode`, `platform`, `challenge_method`, `response_type`) |
| `qoder-queue-frame` | the frame envelope's own `headers` are emptied — no parser reads them and they held the only account-bound values in the frame | the whole queue answer: `code 10605`, `subCode RESOURCE_LIMIT`, `isQueued true`, `retryAfterSeconds 60`, `statusCodeValue 403`, `statusCode FORBIDDEN` |
| `minimax-device-code` | `device_code`, `user_code`, and the code inside `verification_uri_complete` | `expires_in` (300), `interval` (3), `verification_uri` |
| `qoder-login-poll-pending` | `requestId` | `errorCode` (`NotFound`), `errorMessage` |
| `workbuddy-login-start` | `requestId`, `data.state`, the `state` inside `data.authUrl` | `code`, `msg`, `platform=workbuddy` |
| `zcode-login-start` | `flow_id`, `poll_token`, `logid`, and `client_id`/`state` inside `authorize_url` | `code`, `msg`, `poll_interval_sec`, `expires_at`, and the `redirect_uri` inside `authorize_url` (a client constant — it is what makes the URL's shape visible) |
| `catalog-models` | `created` on every entry (a timestamp cannot be both plausible and below the ten-digit shape a leaked token has, so it becomes `0` — no parser reads it) | the model ids, their `object`, `owned_by`, `context_length`, `max_tokens`, `service_status` — the platform's published list is the point of the fixture |

Two things to know about the numbers:

- Durations and statuses are kept as they were (`300`, `60`, `403`): they are
  protocol constants, and a parser branches on them.
- The only ten-digit value left in these files is `1800000000` (`2027-01-15`), in
  `zcode-login-start.json`'s `expires_at`. That field is read by the lib and is the
  one place the seconds-versus-milliseconds handling lives, so it has to stay a
  plausible future timestamp.

## Checks run on these files

- Every file parses with `JSON.parse`.
- Each one was fed back into the lib function that reads that answer, and the
  parsed result checked: 34 assertions, all passing. Notably
  `isRetryableLegacy` returns `true` for the queue frame (so it really is a queue
  answer and not a generic error), `parseLimitError` reports `isQueued` with
  `retryAfterSeconds: 60`, and `pollDeviceTokenOnce` reads the poll's 404 as
  `pending`.
- The wash was verified by grep: no `acw_tc`, `ga-request-id`, `sw-trace-id`, `@`,
  `eyJ`, `sk-` anywhere, and the only ten-digit run is the constant above.

## Re-recording

The recorder is `record-panel-fixtures.ts`, and it has to run **inside** the
container that holds the sessions: the tokens never leave that host and no copy of
the database is made. Its header carries the commands; the short version is
`--capture` (send the requests, raw answers to a temp directory), `--report` (print
each answer's shape — paths, classes and lengths, never values, which is how the
scrubbing rules were written) and `--sanitize` (write the scrubbed files, and those
are the ones copied out).

On the machine that recorded these it sits in `tools/`, which this repository keeps
out of version control on purpose (`.gitignore`: helpers for the machine, not for
the service). So re-recording needs that machine — or the file copied out of it —
rather than a plain checkout. The neighbouring `test/capture-legacy.ts` is the same
kind of script kept inside the repository, and is the model to follow if this one is
ever moved in.

Run `--report` before re-copying anything: if an endpoint changed, the report shows
the new field names and lengths, and `SCRUBBERS` in the recorder needs a matching
rule before a new answer is copied out of the container.
