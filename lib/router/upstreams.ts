// lib/router/upstreams.ts — the four upstream adapters.
//
// Each upstream has its own protocol and its own idea of what a model is
// called, but the way an answer is written back to the client is the same for
// all of them (see deliver.ts). So an adapter only has to do its own part:
// turn the request into what the upstream wants, call it, and hand the answer
// over.

import crypto from "node:crypto";
import type Koa from "koa";
import { AuthError } from "../credential.ts";
import { anthropicToOpenAI, effortFromBudget, openaiToAnthropic } from "../dialect/request.ts";
import {
  qoderProtocolForRegion,
  resolveModelRoute,
  QODER_CLIENT_MAX_TOKENS,
  type QoderModel,
} from "../qoder/models.ts";
import { qoderChatCompletion, LimitError } from "../qoder/transport.ts";
import { legacyChatCompletion, readLegacyFrames } from "../qoder/legacy.ts";
import { workbuddyChat, aggregateStream, conversationIdFor } from "../workbuddy/transport.ts";
import type { WorkBuddyModel } from "../workbuddy/models.ts";
import { MINIMAX_MODELS } from "../minimax/models.ts";
import { pickTenant, tokenRhythmStatuses } from "../tokenrhythm/wallet.ts";
import { tokenRhythmChat, TokenRhythmBusyError } from "../tokenrhythm/transport.ts";
import { senseNovaChat } from "../sensenova/transport.ts";
import { internAiChat } from "../intern-ai/transport.ts";
import { gatewayErrorMessage, minimaxChat, PING_MS } from "../minimax/transport.ts";
import type { QoderRegion } from "../qoder/auth.ts";
import {
  deliverAnthropicStream,
  deliverJson,
  deliverOpenAIChunks,
  deliverOpenAIStream,
  type Dialect,
} from "./deliver.ts";
import { upstreamModel, type Route } from "./routes.ts";

/** The output limit of a MiniMax model, as its own catalog says. */
function minimaxMaxOutput(model: string): number {
  // The catalog is the only place a limit comes from. A made-up number here
  // would be a limit the gateway never agreed to.
  const found = MINIMAX_MODELS.find((m) => m.id === model);
  if (!found) throw new AuthError("unknown minimax model", `没有这个 MiniMax 模型：${model}`, 400);
  return found.output;
}

/** What the adapters need to know about the router they run in. */
export interface UpstreamContext {
  /** The Qoder regions that are on. */
  qoderRegions: QoderRegion[];
  /** How often a queued legacy request is tried again. */
  legacyMaxAttempts: number;
  legacyRetryMs: number;
  /** How often a failed new-protocol request is tried again. */
  qoderMaxAttempts: number;
  /** How often a busy relay is tried again, on the same account. */
  tokenRhythmMaxAttempts: number;
  /** Whether a request is written to the log. */
  logRoute: boolean;
  /** The output limit of a WorkBuddy model, as its own catalogue says. */
  workbuddyMaxOutput(model: string): number;
  /** The model itself, so the request can be built the way the client builds it. */
  workbuddyModel(model: string): WorkBuddyModel | null;
  /** Told what the upstream charged for the answer, if anyone is keeping score. */
  onUsage?: (usage: any) => void;
  /**
   * The usage the last upstream call reported, already counted.
   *
   * The delivery layer calls `onUsage` with the upstream's own usage object;
   * whoever built the context keeps the largest one seen here so the caller
   * can record it after the call. The Anthropic stream reports it in two
   * pieces (the input in message_start, the output in message_delta), so
   * each piece is counted on its own.
   */
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens: number };
}

/**
 * WorkBuddy's China region.
 *
 * The upstream speaks the OpenAI dialect natively, so the request goes out
 * almost unchanged; what the upstream checks is the identity around it, which
 * lib/workbuddy/auth.ts builds.
 *
 * The upstream always answers with a stream, even for a client that asked for
 * none, so a non-streaming request is folded back into one object here.
 */
export async function toWorkBuddy(
  ctx: UpstreamContext,
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  const model = upstreamModel(route);
  openaiBody.model = model;
  // The desktop client sends the limit its session asks for, and that is the
  // model's own output limit unless the user changed it. The upstream cuts the
  // answer there, so the number matters.
  if (typeof openaiBody.max_tokens !== "number") {
    openaiBody.max_tokens = ctx.workbuddyMaxOutput(model);
  }
  if (ctx.logRoute) {
    console.log(`[ROUTE] workbuddy model=${route.model} stream=${stream}`);
  }

  // The conversation keeps its id for every turn, so the upstream can see
  // that the turns belong together.
  const conversationId = conversationIdFor(openaiBody.messages, openaiBody.conversation_id);
  const { response } = await workbuddyChat(openaiBody, {
    region: "cn",
    stream,
    conversationId,
    model: ctx.workbuddyModel(model),
  });

  if (!stream) {
    // The upstream always answers with a stream, so a non-streaming request is
    // folded back into one object here.
    let json: any;
    try {
      json = await aggregateStream(response, model);
    } catch (e) {
      throw new AuthError(
        `upstream stream failed (${(e as Error)?.message ?? "unknown"})`,
        "WorkBuddy 的响应流中断了。",
        502,
      );
    }
    deliverJson(out, dialect, "openai", json, route.label ?? model, ctx.onUsage);
    return;
  }

  await deliverOpenAIStream(out, response.body!, dialect, route.label ?? model, undefined, ctx.onUsage);
}

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
export function extractEffort(body: Record<string, any>): string | undefined {
  const candidates = [body.output_config?.effort, body.effort, body.reasoning_effort];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }

  const budget = body.thinking?.budget_tokens ?? body.thinking_budget_tokens ?? body.thinking_budget;
  if (typeof budget === "number" && budget > 0) return effortFromBudget(budget);
  return undefined;
}

export async function toQoder(
  ctx: UpstreamContext,
  body: Record<string, any>,
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
  const region = route.region ?? ctx.qoderRegions[0] ?? "global";
  const { model, key } = resolveModelRoute(upstreamModel(route), effort, region);
  if (ctx.logRoute) {
    console.log(`[ROUTE] model=${route.model} region=${region} effort=${effort ?? "-"} -> upstream key=${key}`);
  }
  if (model && qoderProtocolForRegion(model, region) === "legacy") {
    await toQoderLegacy(ctx, openaiBody, model, dialect, stream, out, region, route.label);
    return;
  }

  openaiBody.model = key;
  // The official client sends the limit from its own catalog, whatever the
  // caller asked for; the gateway ignores it and cuts the answer at the
  // model's real limit.
  openaiBody.max_tokens = QODER_CLIENT_MAX_TOKENS;
  const upstream = await qoderWithRetry(
    () => qoderChatCompletion(openaiBody, { stream, region }),
    ctx.qoderMaxAttempts,
  );

  if (!stream) {
    const json = await upstream.json();
    deliverJson(out, dialect, "openai", json, route.label ?? upstreamModel(route), ctx.onUsage);
    return;
  }

  await deliverOpenAIStream(out, upstream.body!, dialect, route.label ?? upstreamModel(route), undefined, ctx.onUsage);
}

/**
 * The legacy (COSY) protocol, for the models the new one refuses.
 *
 * Its response is Qoder's own frame format, so the frames are unwrapped into
 * plain OpenAI chunks and then converted like any other upstream. The non-
 * streaming case has no upstream equivalent, so the chunks are collected and
 * reassembled into one completion.
 */
export async function toQoderLegacy(
  ctx: UpstreamContext,
  openaiBody: Record<string, any>,
  model: QoderModel,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
  region: QoderRegion,
  label?: string,
): Promise<void> {
  const chunks = legacyWithRetry(
    () =>
      legacyChatCompletion(
        {
          messages: Array.isArray(openaiBody.messages) ? openaiBody.messages : [],
          tools: Array.isArray(openaiBody.tools) ? openaiBody.tools : undefined,
          modelKey: model.key,
          displayName: model.name,
          // The same number the official client sends.
          maxTokens: QODER_CLIENT_MAX_TOKENS,
          reasoning: model.reasoning,
          contextWindow: model.context,
        },
        { region },
      ),
    ctx.legacyMaxAttempts,
    ctx.legacyRetryMs,
  );

  if (!stream) {
    // The legacy protocol has no non-streaming answer, so the chunks are
    // collected and reassembled into one completion.
    const completion = await collectOpenAIChunks(chunks, model.id);
    deliverJson(out, dialect, "openai", completion, label ?? model.id, ctx.onUsage);
    return;
  }

  await deliverOpenAIChunks(out, chunks, dialect, label ?? model.id, ctx.onUsage);
}

export function legacyError(error: { code?: string; message?: string; status?: number }): AuthError {
  // A 403 with a pricing link is the platform saying the account has no
  // credits left. Saying so is more use than the code it answers with.
  if (error.status === 403 && /pricing/i.test(error.message ?? "")) {
    return new AuthError(
      "the qoder account has no credits left",
      "Qoder 的额度用完了（套餐和加购都没了）。充值，或等额度重置后再试。",
      402,
      "usage_limit_error",
    );
  }
  return new AuthError(
    `legacy upstream error (${error.code ?? "unknown"})`,
    `${error.message ?? "upstream failed"}${error.status ? ` (HTTP ${error.status})` : ""}`,
    error.status && error.status >= 500 ? 502 : 503,
  );
}

/**
 * The legacy endpoint answers 429 with `provider_error` / "All backends failed"
 * while the model is queued or the account is rate limited, and the CLI retries
 * such a request rather than failing it. The first frame tells us whether the
 * attempt was queued, so the retry happens before any bytes reach the client.
 */
async function* legacyWithRetry(
  send: () => Promise<Response>,
  maxAttempts: number,
  retryMs: number,
): AsyncGenerator<Record<string, any>> {
  for (let attempt = 1; ; attempt++) {
    const upstream = await send();
    const frames = readLegacyFrames(upstream.body!)[Symbol.asyncIterator]();
    const first = await frames.next();

    if (!first.done && first.value.error && attempt < maxAttempts && isRetryableLegacy(first.value.error)) {
      await new Promise((r) => setTimeout(r, retryMs));
      continue;
    }
    if (!first.done) {
      if (first.value.error) throw legacyError(first.value.error);
      if (first.value.chunk) yield first.value.chunk;
    }
    while (true) {
      const next = await frames.next();
      if (next.done) break;
      if (next.value.error) throw legacyError(next.value.error);
      if (next.value.chunk) yield next.value.chunk;
    }
    return;
  }
}

export function isRetryableLegacy(error: { code?: string; status?: number }): boolean {
  return error.status === 429 || error.code === "provider_error";
}

/**
 * The upstream answers 403/429 when the model is queued or every backend for it
 * is busy — the CLI retries these, so the proxy does too. The request has not
 * produced any bytes yet, so the retry is invisible to the client.
 */
export async function qoderWithRetry(
  send: () => Promise<Response>,
  maxAttempts: number,
  logRoute = false,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      if (e instanceof LimitError && attempt < maxAttempts) {
        if (logRoute) console.log(`[ROUTE] upstream busy, retry ${attempt}/${maxAttempts - 1} in ${e.retryAfterSec}s`);
        await new Promise((r) => setTimeout(r, e.retryAfterSec * 1000));
        continue;
      }
      throw e;
    }
  }
}

/** Collect a chunk stream into a single chat completion. */
export async function collectOpenAIChunks(
  chunks: AsyncGenerator<Record<string, any>>,
  model: string,
): Promise<Record<string, any>> {
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const toolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let usage: Record<string, any> | undefined;

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
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

  const message: Record<string, any> = { role: "assistant", content: toolCalls.size ? null : content };
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

export async function toMinimax(
  ctx: UpstreamContext,
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  // MiniMax speaks Anthropic natively. The Anthropic dialect insists on a
  // limit, so when the client did not name one the model's own is used.
  const anthropicBody =
    dialect === "anthropic" ? { ...body } : openaiToAnthropic(body, minimaxMaxOutput(upstreamModel(route)));
  anthropicBody.model = upstreamModel(route);
  anthropicBody.stream = stream;

  let r: Response;
  try {
    r = await minimaxChat(anthropicBody, stream);
  } catch (e) {
    const err = e as AuthError;
    throw new AuthError(err.message, err.hint, err.status, err.type);
  }

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    const { type, message } = gatewayErrorMessage(r.status, parsed, text);
    throw new AuthError(message, "", r.status, type);
  }

  if (!stream) {
    const json = await r.json();
    deliverJson(out, dialect, "anthropic", json, route.label ?? upstreamModel(route), ctx.onUsage);
    return;
  }

  await deliverAnthropicStream(out, r.body!, dialect, route.label ?? upstreamModel(route), PING_MS, ctx.onUsage);
}


/**
 * TokenRhythm, the relay station.
 *
 * The upstream speaks the OpenAI dialect, so a request in that dialect goes
 * out nearly unchanged and the answer comes back the same way. An Anthropic
 * request is converted first.
 *
 * Which account pays for it is decided by the gift money: the gift that runs
 * out first is spent first, and the money that was paid for is the last
 * resort.
 */
export async function toTokenRhythm(
  ctx: UpstreamContext,
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  const model = upstreamModel(route);
  openaiBody.model = model;
  openaiBody.stream = stream;

  const statuses = await tokenRhythmStatuses();
  const tenant = pickTenant(statuses);
  if (!tenant) {
    throw new AuthError(
      "no tokenrhythm account has credit left",
      "TokenRhythm 的账号都没有可用的余额了。",
      503,
    );
  }
  if (ctx.logRoute) {
    console.log(`[ROUTE] tokenrhythm model=${route.model} tenant=${tenant.index} stream=${stream}`);
  }

  const { response } = await tokenRhythmChatWithRetry(
    tenant.index,
    openaiBody,
    ctx.tokenRhythmMaxAttempts,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AuthError(
      `upstream HTTP ${response.status}`,
      `TokenRhythm 上游返回 ${response.status}：${text.slice(0, 300)}`,
      502,
    );
  }

  if (!stream) {
    const json = await response.json();
    const reason = json?.choices?.[0]?.finish_reason;
    if (reason === "length") noteTruncation(openaiBody, model, tenant.index);
    deliverJson(out, dialect, "openai", json, route.label ?? model, ctx.onUsage);
    return;
  }

  await deliverOpenAIStream(out, response.body!, dialect, route.label ?? model, (reason) => {
    if (reason === "length") noteTruncation(openaiBody, model, tenant.index);
  }, ctx.onUsage);
}

/**
 * Say that an answer was cut short because the client asked for a very small
 * number of tokens.
 *
 * pi warms its prompt cache with a request for a single token, and the upstream
 * duly answers with a single token and says it stopped there. The client then
 * treats the answer as broken, and from the outside it looks like the gateway
 * truncated something. The log says where the number came from.
 */
function noteTruncation(body: Record<string, any>, model: string, tenant: number): void {
  const asked = typeof body.max_tokens === "number" ? body.max_tokens : null;
  console.log(
    `[TRUNCATED] model=${model} tenant=${tenant} asked_for=${asked ?? "unset"} tokens — ` +
      `the upstream stopped at the limit the client set`,
  );
}

/**
 * Try the same account again when the relay says it is busy.
 *
 * The account is not changed: another account would have to read the prompt
 * from the start, and the relay charges the uncached prompt — which is a lot
 * more than the answer itself. So the request waits and is sent again to the
 * account it was meant for.
 */
async function tokenRhythmChatWithRetry(
  tenant: number,
  body: Record<string, any>,
  maxAttempts: number,
): Promise<{ response: Response; key: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await tokenRhythmChat(tenant, body);
    } catch (e) {
      if (e instanceof TokenRhythmBusyError && attempt < maxAttempts) {
        console.log(
          `[ROUTE] tokenrhythm busy on tenant ${tenant} (${e.traceId || e.message}), ` +
            `retry ${attempt}/${maxAttempts - 1} in ${e.retryAfterSec}s`,
        );
        await new Promise((r) => setTimeout(r, e.retryAfterSec * 1000));
        continue;
      }
      if (e instanceof TokenRhythmBusyError) {
        throw new AuthError(
          "tokenrhythm is busy",
          `TokenRhythm 现在繁忙（${e.message}）。这是上游的临时状态，稍后重试即可；` +
            `账号没有换，避免提示词缓存失效。${e.traceId ? `traceId=${e.traceId}` : ""}`.trim(),
          503,
          "api_error",
        );
      }
      throw e;
    }
  }
}

/**
 * SenseNova。
 *
 * 上游讲 OpenAI 方言，所以请求几乎原样发过去，答案也原样回来。Anthropic 的
 * 请求先转成 OpenAI。
 *
 * 鉴权用的是账号上的推理 key（不是 cookie）：cookie 是登录态，key 才是推理
 * 端点要的东西。
 */
export async function toSenseNova(
  ctx: UpstreamContext,
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  const model = upstreamModel(route);
  openaiBody.model = model;
  openaiBody.stream = stream;
  if (ctx.logRoute) {
    console.log(`[ROUTE] sensenova model=${route.model} stream=${stream}`);
  }

  const response = await senseNovaChat(openaiBody);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AuthError(
      `upstream HTTP ${response.status}`,
      `SenseNova 上游返回 ${response.status}：${text.slice(0, 300)}`,
      502,
    );
  }

  if (!stream) {
    const json = await response.json();
    deliverJson(out, dialect, "openai", json, route.label ?? model, ctx.onUsage);
    return;
  }

  await deliverOpenAIStream(out, response.body!, dialect, route.label ?? model, undefined, ctx.onUsage);
}

/**
 * 书生·端砚（Discovery 子站）。
 *
 * 与 SenseNova 一样是 OpenAI 方言：请求原样发过去，答案原样回来。
 */
export async function toInternAi(
  ctx: UpstreamContext,
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  const model = upstreamModel(route);
  openaiBody.model = model;
  openaiBody.stream = stream;
  if (ctx.logRoute) {
    console.log(`[ROUTE] intern-ai model=${route.model} stream=${stream}`);
  }

  const response = await internAiChat(openaiBody);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AuthError(
      `upstream HTTP ${response.status}`,
      `书生·端砚上游返回 ${response.status}：${text.slice(0, 300)}`,
      502,
    );
  }

  if (!stream) {
    const json = await response.json();
    deliverJson(out, dialect, "openai", json, route.label ?? model, ctx.onUsage);
    return;
  }

  await deliverOpenAIStream(out, response.body!, dialect, route.label ?? model, undefined, ctx.onUsage);
}
