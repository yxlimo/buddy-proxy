// lib/router/upstreams/qoder.ts — Qoder.
//
// One protocol, the CLI's own (COSY): its answer is Qoder's own frame format,
// which is unwrapped into plain chunks here.

import type { Json } from "../../json.ts";
import crypto from "node:crypto";
import type Koa from "koa";
import { AuthError } from "../../credential.ts";
import { businessCodeOfPayload, isBusinessErrorEnvelope, withBusinessCode, withUpstreamAnswer } from "../../upstream-status.ts";
import { scrubForClient, scrubForLog } from "../../log-scrub.ts";
import { anthropicToOpenAI, effortOf } from "../../dialect/request.ts";
import {
  resolveModelRoute,
  QODER_CLIENT_MAX_TOKENS,
  type QoderModel,
} from "../../qoder/models.ts";
import { QueuedError, parseLimitError } from "../../qoder/queue.ts";
import type { QoderRegion } from "../../qoder/auth.ts";
import { legacyChatCompletion, readLegacyFrames } from "../../qoder/legacy.ts";
import { deliverJson, deliverOpenAIChunks, type Dialect } from "../deliver.ts";
import { platformOf } from "../../platforms.ts";
import { upstreamModel, type Route } from "../routes.ts";
import { type UpstreamContext, settlement, underPolicy } from "./policy.ts";
import { runUnderClientGone } from "./client-gone.ts";

/**
 * The thinking level a request asks for.
 *
 * Several shapes reach the proxy, depending on the client and the dialect:
 *   `output_config.effort`  — the Anthropic spelling opencode and pi use
 *   `effort`                — explicit, and the only way to ask for `max`
 *   `reasoning_effort`      — the OpenAI spelling
 *   `thinking.budget_tokens` — the Anthropic spelling with a budget instead of a
 *                              level, where the level has to be recovered
 *
 * Qoder's own protocol has no per-request thinking switch: the tier *is* the
 * switch, so the level is translated into a tier here.
 */
export function extractEffort(body: Json): string | undefined {
  return effortOf(body);
}

export async function toQoder(
  ctx: UpstreamContext,
  body: Record<string, unknown>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  // Qoder speaks OpenAI natively, so the request is either already OpenAI or is
  // converted once.
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  openaiBody.stream = stream;

  // Read the effort from the original request: the dialect conversion drops the
  // Anthropic spelling (`output_config.effort`), and that is where opencode and
  // pi put it.
  const effort = extractEffort(body);
  // The region is the platform's, not an account's: the global and the China
  // Qoder are two platforms, each with its own endpoints.
  const region: QoderRegion = platformOf(route.platform)?.region === "cn" ? "cn" : "global";
  const { model, key } = resolveModelRoute(upstreamModel(route), effort, region);
  if (ctx.logRoute) {
    console.log(`[ROUTE] model=${route.model} region=${region} effort=${effort ?? "-"} -> upstream key=${key}`);
  }
  await toQoderLegacy(ctx, openaiBody, model, key, dialect, stream, out, region, route.label, route.platform);
}

/**
 * The CLI's own (COSY) protocol — the only one the upstream has.
 *
 * Its response is Qoder's own frame format, so the frames are unwrapped into
 * plain OpenAI chunks and then converted like any other upstream. The non-
 * streaming case has no upstream equivalent, so the chunks are collected and
 * reassembled into one completion.
 */
export async function toQoderLegacy(
  ctx: UpstreamContext,
  openaiBody: Record<string, unknown>,
  model: QoderModel | undefined,
  key: string,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
  region: QoderRegion,
  label?: string,
  platform = "qoder",
): Promise<void> {
  const settle = settlement();
  // 老协议发的是同一个固定上限（下面 parameters 里的 max_tokens）。
  ctx.upstreamMaxTokens = QODER_CLIENT_MAX_TOKENS;
  // An id that is not in the catalogue is passed through unchanged: the upstream
  // rejects it with a clear message, which beats the proxy guessing at one.
  const modelKey = model?.key ?? key;
  const answeredAs = label ?? model?.id ?? modelKey;
  // 客户端走了就把上游停掉：上游还在算就是在计费，账号还占着。
  //
  // 非流式那条路尤其要紧：答复要等整个上游的答复读完才发出去，客户端在这
  // 中间走了（超时、按了取消），没人停上游的话它就接着算到超时（2026-11-03，
  // 作者复查发现）。
  await runUnderClientGone(out, async (guard) => {
    const chunks = await underPolicy(
      platform,
      "qoder",
      async (account) =>
        legacyWithRetry(
          () =>
            legacyChatCompletion(
              {
                messages: Array.isArray(openaiBody.messages) ? openaiBody.messages : [],
                tools: Array.isArray(openaiBody.tools) ? openaiBody.tools : undefined,
                modelKey,
                displayName: model?.name ?? modelKey,
                // The same number the simulated client sends.
                maxTokens: QODER_CLIENT_MAX_TOKENS,
                reasoning: model?.reasoning ?? false,
                contextWindow: model?.context,
              },
              { providerId: account.id, region, signal: guard.signal },
            ).catch((e) => {
              // 客户端走了不是上游的错：策略看到的是这个，它才不会给账号记冷却。
              throw guard.fail(e) ?? e;
            }),
          ctx.legacyRetryMs,
        ),
      settle,
      ctx.availability,
    );

    if (!stream) {
      // The legacy protocol has no non-streaming answer, so the chunks are
      // collected and reassembled into one completion.
      let completion: Json;
      try {
        completion = await collectOpenAIChunks(chunks, answeredAs);
      } catch (e) {
        // 客户端走了不是上游的错：账号不该记冷却，这个请求也不该再打一次。
        const gone = guard.fail(e);
        if (gone) {
          settle.failure(gone);
          throw gone;
        }
        // 帧读到一半断了：那是上游的失败，账号要记冷却。
        settle.failure(e);
        throw e;
      }
      deliverJson(out, dialect, "openai", completion, answeredAs, ctx.onUsage);
      settle.success();
      return;
    }

    // 流式那条路：答复是边读边发的，客户端走了由答复那一层管（见
    // lib/router/deliver.ts 的 replyState）。这里不再盯 —— 流式那条路的客户端
    // 走了，靠的是答复那一层自己的监听器与看门狗。
    guard.done();
    try {
      await deliverOpenAIChunks(out, chunks, dialect, answeredAs, ctx.onUsage, (e) => settle.failure(e));
      settle.success();
    } catch (e) {
      settle.failure(e);
      throw e;
    }
  });
}

/**
 * The longest a queued attempt waits before it is tried again.
 *
 * The queue answer says how long it wants us to wait, but that is a hint, not a
 * contract: a wrong or huge number would park the request for minutes while the
 * client is still holding the socket open. A minute is the longest the queue
 * itself hands out, so that is the ceiling here.
 */
const LEGACY_MAX_WAIT_MS = 60_000;

/** How many nested JSON strings the log line is willing to unwrap. */
const LEGACY_LOG_DEPTH = 3;

/** 超出深度时日志里那句话：不输出正文，也不能让它看起来像「上游没说话」。 */
const UNPARSED_BODY = "(正文未解析)";

/**
 * The frame's message, scrubbed for the log.
 *
 * The message is JSON nested inside a JSON string (the queue answer is two
 * levels deep), and scrubForLog only reaches the levels it can parse — a
 * `cookie` one level down would reach the container log untouched. So every
 * nested layer is scrubbed on its own and written back before the outer layer
 * is scrubbed.
 *
 * 深过 LEGACY_LOG_DEPTH 那一层就不再拆了，正文整段不输出：拆不开的那一层里
 * 有没有 cookie 只能靠文本规则碰运气，而碰运气不算脱敏。
 */
function scrubLegacyMessage(text: string, depth = 0): string {
  const parsed = parseJsonObject(text);
  // 不是 JSON：没有嵌套可拆，文本规则已经是全部能做的。
  if (!parsed) return scrubForLog(text, 500);
  if (depth >= LEGACY_LOG_DEPTH) return UNPARSED_BODY;
  return scrubForLog(JSON.stringify(scrubNestedLayers(parsed, depth)), 500);
}

/** A JSON value as the log line rebuilds it, after scrubbing. */
type ScrubbedValue = string | number | boolean | null | ScrubbedValue[] | { [key: string]: ScrubbedValue };

function scrubNestedLayers(value: ScrubbedValue, depth: number): ScrubbedValue {
  if (Array.isArray(value)) return value.map((item) => scrubNestedLayers(item, depth));
  if (value && typeof value === "object") {
    const out: Record<string, ScrubbedValue> = {};
    for (const [key, inner] of Object.entries(value as Record<string, ScrubbedValue>)) {
      out[key] =
        typeof inner === "string" && parseJsonObject(inner)
          ? scrubLegacyMessage(inner, depth + 1)
          : scrubNestedLayers(inner, depth);
    }
    return out;
  }
  return value;
}

/** The text as a JSON object, or undefined when it is not one. */
function parseJsonObject(text: string): Json | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 上游为什么拒，写进日志。
 *
 * The upstream's own words only ever go into `hint`, and the log and the usage
 * table only keep `message` — so why it refused was unreadable once the
 * container was rebuilt (2026-11-10: the queue answer was only found by sending
 * a request by hand). This line is the one place that survives. 排队用尽与
 * 帧内错误都是上游拒了，两条路都得有这一行。
 */
function logLegacyFrameError(error: { code?: string; message?: string }): void {
  console.warn(
    `[UPSTREAM] Qoder 老协议帧内错误 ${error.code ?? "unknown"}：${scrubLegacyMessage(error.message ?? "")}`,
  );
}

/**
 * A 403 with a pricing link is the platform saying the account has no credits
 * left.
 *
 * 两个地方认得它（没额度那一支与重试判断），所以只判一遍：判两遍就是同一
 * 条答复两种待遇的来源。
 */
function isNoCreditRefusal(error: { status?: number; message?: string }): boolean {
  return error.status === 403 && /pricing/i.test(error.message ?? "");
}

export function legacyError(error: { code?: string; message?: string; status?: number; text?: string }): AuthError {
  logLegacyFrameError(error);
  // A 403 with a pricing link is the platform saying the account has no
  // credits left. Saying so is more use than the code it answers with.
  if (isNoCreditRefusal(error)) {
    return new AuthError(
      "the qoder account has no credits left",
      "Qoder 的额度已用尽（套餐与加购额度均无）。请充值，或等额度重置后重试。",
      402,
      "usage_limit_error",
    );
  }
  const refused = new AuthError(
    `legacy upstream error (${error.code ?? "unknown"})`,
    // 这一帧自己的那句话是客户端看的（它进 hint）：抹一遍再给出去。
    `${scrubForClient(error.message ?? "upstream failed", 300)}${error.status ? ` (HTTP ${error.status})` : ""}`,
    error.status && error.status >= 500 ? 502 : 503,
  );
  // 帧里那个状态也要带在错误上：路由靠它分清「请求本身的问题」与「这个账号
  // 接不了」。没额度那一支已经自己说了（402 / usage_limit_error），不盖它。
  //
  // 状态与正文一起带：重试用尽之后客户端读的是上游这一帧自己的正文，而不是
  // 网关根据状态回编的一句「上游返回 500。」（见 lib/upstream-status.ts 的
  // withUpstreamAnswer）。这一帧没有正文时正文就是空：那说的是「上游没说
  // 什么」，不是网关自己编了一句。
  return error.status ? withUpstreamAnswer(refused, error.status, error.text ?? "") : refused;
}

/** Waits, the way the retry loop does. Injectable so a test can watch it. */
export type LegacySleep = (ms: number) => Promise<void>;

const realSleep: LegacySleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 排队等过一次仍是排队：交出去。
 *
 * 以前这里抛的是 legacyError，它对 403 给 503 —— 分类按 5xx 把它当「上游挂了」：
 * 健康账号被记冷却，而策略还会在同一个账号上再跑一轮（客户端最坏等 240s+）。
 *
 * `QueuedError` 说的是「这个模型在上游没排上，等过了也没排上」：分类把它当成
 * 可降级的失败（换一个目标：另一个上游有自己的队列）且不写冷却（账号没坏，它
 * 别的模型现在就能接）。见 lib/qoder/queue.ts。
 */
function queueExhausted(error: { code?: string; message?: string }, attempts: number): QueuedError {
  logLegacyFrameError(error);
  return new QueuedError(
    `qoder model is still queued after ${attempts} attempts`,
    `上游把这个模型排进了队列：等到它给的时间再试，仍在排队（共试了 ${attempts} 次）。` +
      "换一个上游或换一个模型才有用，稍后再试这个模型。",
    queueSeconds(error),
  );
}

/**
 * 上游要我们等多少秒，夹到单次等待的那个上限（见 LEGACY_MAX_WAIT_MS）。
 *
 * 没有秒数就用上限：这个值只说「过多久再来试」，宁可报大一点，也别给客户端
 * 一个一定会再排不上的假希望。
 */
function queueSeconds(error: { message?: string }): number {
  const asked = parseLimitError(error.message ?? "")?.retryAfterSec;
  const maxSec = LEGACY_MAX_WAIT_MS / 1000;
  const seconds = typeof asked === "number" && Number.isFinite(asked) ? Math.round(asked) : maxSec;
  return Math.min(Math.max(seconds, 1), maxSec);
}

/**
 * 排队等几次。一次 —— 实测的结论，不是保守。
 *
 * 上游给的秒数兑现不了：等满 60 秒再打，第一帧还是同一个排队答复（2026-11-11
 * 实测，两个账号、`p4` 队列）。多等几轮只是把客户端挂在连接上，不是恢复。所以
 * 等一次，再打一次，仍是排队就交出去：
 *
 *   - 交出去，策略才能换下一个目标（分类把排队算可降级）；
 *   - 同一个账号不再重打（排队不在瞬时失败那一类里，见 policy.ts）。
 */
const LEGACY_QUEUE_WAITS = 1;

/**
 * The legacy endpoint answers 429 with `provider_error` / "All backends failed"
 * while the model is queued or the account is rate limited, and the CLI retries
 * such a request rather than failing it. The first frame tells us whether the
 * attempt was queued, so the retry happens before any bytes reach the client.
 *
 * The queue answer also says how long to wait; that wait is taken from it when
 * it says so (see `legacyWaitMs`). The wait happens once (LEGACY_QUEUE_WAITS),
 * because the seconds the upstream gives are not a promise it keeps.
 *
 * When the wait does not help, the answer is a `QueuedError` (see
 * `queueExhausted`): the model has no slot, the account is fine, and another
 * target is worth trying.
 */
export async function* legacyWithRetry(
  send: () => Promise<Response>,
  retryMs: number,
  sleep: LegacySleep = realSleep,
): AsyncGenerator<Json> {
  for (let attempt = 1; ; attempt++) {
    const upstream = await send();
    const frames = readLegacyFrames(upstream.body!)[Symbol.asyncIterator]();
    try {
      const first = await frames.next();

      if (!first.done && first.value.error && attempt <= LEGACY_QUEUE_WAITS && isRetryableLegacy(first.value.error)) {
        const waitMs = legacyWaitMs(first.value.error, retryMs);
        // 等多久只有这一行留得住：下一次尝试成功的话，别的日志里一点痕迹都没有。
        console.warn(`[UPSTREAM] Qoder 老协议排队，等 ${waitMs}ms 后再试一次`);
        await sleep(waitMs);
        continue;
      }
      if (!first.done) {
        if (first.value.error) {
          // 等过一次还是排队：这不是「这个账号坏了」，是模型没排上。
          if (isRetryableLegacy(first.value.error)) throw queueExhausted(first.value.error, attempt);
          throw legacyError(first.value.error);
        }
        if (first.value.chunk) yield first.value.chunk;
      }
      while (true) {
        const next = await frames.next();
        if (next.done) break;
        if (next.value.error) throw legacyError(next.value.error);
        if (next.value.chunk) yield next.value.chunk;
      }
      return;
    } finally {
      // 客户端走了（调用方不再读这个生成器）时，把这一条上游的流取消掉：它还
      // 在吐字就是在计费，账号还占着。取消不了就算了（上游自己会超时）。
      try {
        await frames.return?.(undefined);
      } catch {
        /* 已经结束了 */
      }
    }
  }
}

/**
 * How long the next attempt waits.
 *
 * The queue answer carries the seconds it wants back (`retryAfterSeconds`, or
 * `waitTime` in the older spelling) nested inside the frame's message, so it is
 * parsed rather than read off the text. Without a number the configured wait is
 * used, and either way the wait is capped — see LEGACY_MAX_WAIT_MS.
 */
export function legacyWaitMs(error: { message?: string }, fallbackMs: number): number {
  const asked = parseLimitError(error.message ?? "")?.retryAfterSec;
  const waitMs = typeof asked === "number" && Number.isFinite(asked) ? asked * 1000 : fallbackMs;
  return Math.min(Math.max(waitMs, 0), LEGACY_MAX_WAIT_MS);
}

/**
 * Whether a legacy frame says the model is only waiting for a slot.
 *
 * 只看结构，不在正文里找字：`10605` / `RESOURCE_LIMIT` 这几个字符完全可能
 * 是请求 id 或时间戳的一部分，扫字符串把它们当成排队，白白多等一轮 60 秒。
 * 结构就是那个结构：帧里的 code，或者嵌套那一层的 subCode / isQueued。
 * 解析不出来的就不猜。
 *
 * The old spelling is 429 with `provider_error` (every backend for the model is
 * busy), which the CLI retries just the same.
 */
export function isRetryableLegacy(error: { code?: string; status?: number; message?: string }): boolean {
  // 没额度不是排队：钱没到账排多久也排不上，重试只是白等两轮。
  if (isNoCreditRefusal(error)) return false;
  if (error.status === 429 || error.code === "provider_error") return true;
  if (error.code === "10605") return true;
  return saysQueued(error.message ?? "");
}

/**
 * 正文里那句答复说的是不是「模型在排队」。
 *
 * 答复是 JSON 套 JSON：外层说 code/subCode，内层（`message` 那个字符串）说
 * isQueued 与秒数。两层的 subCode 都认 —— 生产上两层都写过。
 */
function saysQueued(text: string): boolean {
  const outer = parseJsonObject(text);
  if (!outer) return false;
  const nested = typeof outer.message === "string" ? parseJsonObject(outer.message) : undefined;
  const inner = nested ?? outer;
  if (inner.isQueued === true || outer.isQueued === true) return true;
  return inner.subCode === "RESOURCE_LIMIT" || outer.subCode === "RESOURCE_LIMIT";
}

/** Collect a chunk stream into a single chat completion. */
export async function collectOpenAIChunks(
  chunks: AsyncGenerator<Json>,
  model: string,
): Promise<Json> {
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const toolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let usage: Json | undefined;

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    // 上游有时用 200 回一个错：正文里只有业务码，没有答复。当成正常的帧
    // 的话，客户端收到一个空的 200 答复（2026-11-03）。
    if (isBusinessErrorEnvelope(chunk)) {
      const code = businessCodeOfPayload(chunk) ?? 0;
      const said = typeof chunk.msg === "string" ? chunk.msg : typeof chunk.message === "string" ? chunk.message : "";
      throw withBusinessCode(
        new AuthError(`upstream rejected the request (${code})`, scrubForClient(said, 300) || "upstream rejected the request", 502),
        code,
      );
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof call.index === "number" ? call.index : 0;
      const existing = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.function.name = call.function.name;
      if (typeof call.function?.arguments === "string") existing.function.arguments += call.function.arguments;
      toolCalls.set(index, existing);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message: Json = { role: "assistant", content: toolCalls.size ? null : content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].map(([index, call]) => ({ index, ...call }));

  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage: usage
      ? {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        }
      : undefined,
  };
}
