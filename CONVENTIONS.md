# Subagent conventions

Rules for any subagent working in this repository. The main agent dispatched you for a
bounded task; this file is what applies to you, and `AGENTS.md` is what applies to the
main agent.

## What to read, and what to skip

Read `AGENTS.md` for the domain vocabulary (agent / simulated client / upstream / provider),
how the project is laid out, and the non-negotiable safety rules. **Skip every section
wrapped in `<!-- main-agent-only:start -->` … `<!-- main-agent-only:end -->`:** dispatch
discipline and the pre-commit privacy review are the main agent's job, not yours.

Your own role file (`.pi/agents/<role>.md`) wins over both when they disagree about scope.

## You do not ship

- Do not `git commit`, do not deploy, do not push. Stop when the change and its tests are
  done and report.
- Do not widen the scope you were given. If the work genuinely requires touching a file
  outside it, say so and stop rather than editing it.

## Tests: run the group that covers your change

`mise run check` is the full gate the main agent runs before committing (about six minutes).
While developing, run only the group covering what you touched:

| Group | Covers |
| --- | --- |
| `mise run check:admin` | panel backend: accounts, credentials, platforms, model catalogue (`lib/admin`, `lib/provider-kinds.ts`, `lib/platforms*`, `lib/model-catalog*`) |
| `mise run check:routing` | account selection, fallback, cooldown, health, usage, timer jobs (`lib/router`, `lib/cooldown*`, `lib/session*`, `lib/periodic*`) |
| `mise run check:deliver` | response delivery: frames, backpressure, dialects, client gone, log scrubbing (`lib/router/handle.ts`, `lib/dialect`, `lib/log-scrub*`) |
| `mise run check:kinds` | the upstream kinds, simulated clients and open platforms (`lib/kinds`, `lib/minimax`, `lib/qoder`, `lib/workbuddy`, `lib/zcode`, `lib/tokenrhythm`, `lib/intern-ai`, `lib/qiniu`, `lib/xinghuo`, `lib/sensenova`) |
| `mise run check:misc` | catalogue parity, cleanup rules, helper scripts, the privacy scanner's own test, the offline matrix |
| `mise run check:web` | panel frontend, no browser (`web/src`) |
| `mise run check:panel` | panel end-to-end suite in a real browser (needs system chromium, about 90 seconds) |

Touched `proto/**`? Run `mise run proto` yourself and commit nothing until both
generated copies (`lib/gen` and `web/.gen`) are in place.

The main agent runs `mise run privacy` first, then the full `mise run check` before
committing. You do not commit, so you only need the group above — but do not leave real
identities, credentials or internal addresses behind for that scan to find.

## Facts that cost someone an afternoon

- Upstream response bodies belong in the log, not just the status code. When hunting an
  upstream's behaviour, record one real response, then replay it against a local fake.
- The panel shows a platform green only when it can actually serve a request today.
- Out-of-credits, out-of-balance and queueing are different states; do not map one onto
  another.

## Local experiments

You may start another instance on this machine only if it uses its **own** `BUDDY_DATA_DIR`
and holds **no session** that the NAS accounts use — sharing one session between two
processes burns the token (that is the 2026-10-25 incident). Never start a second gateway
on a copy of the production database.

## Test samples

Fabricated credentials and upstream responses go in tests as obviously fake values
(`sk-TESTONLY…`, `example.com`, `probe.example`). When the shape itself is what the test
must preserve, mark that single line:

```ts
api_key: "sk-TESTONLY0000000000", // privacy:allow — fabricated sample
```

The marker covers one line only, and never a real value. This repository is public.
