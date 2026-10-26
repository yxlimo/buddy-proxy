// lib/router/upstreams.ts — the upstream adapters, one per kind.
//
// Each upstream has its own protocol and its own idea of what a model is
// called, but the way an answer is written back to the client is the same for
// all of them (see deliver.ts). So an adapter only has to do its own part:
// turn the request into what the upstream wants, call it, and hand the answer
// over.

import type { Json } from "../json.ts";
import crypto from "node:crypto";
import type Koa from "koa";
import { AuthError } from "../credential.ts";
import { anthropicToOpenAI, effortOf, openaiToAnthropic } from "../dialect/request.ts";
import {
  qoderProtocolForRegion,
  resolveModelRoute,
  QODER_CLIENT_MAX_TOKENS,
  type QoderModel,
} from "../qoder/models.ts";
import { qoderChatCompletion, LimitError } from "../qoder/transport.ts";
import type { QoderRegion } from "../qoder/auth.ts";
import { legacyChatCompletion, readLegacyFrames } from "../qoder/legacy.ts";
import { workbuddyChat, aggregateStream, conversationIdFor } from "../workbuddy/transport.ts";
import type { WorkBuddyModel } from "../workbuddy/models.ts";
import { MINIMAX_MODELS } from "../minimax/models.ts";
import {
  markAccountOutOfMoney,
  orderedAccounts,
  resetTokenRhythmStatusCache,
  tokenRhythmStatuses,
  usableAccounts,
  type TokenRhythmAccountStatus,
} from "../tokenrhythm/wallet.ts";
import {
  pinnedBalanceAccount,
  setBalanceAccount,
} from "../tokenrhythm/balance.ts";
import { kindOf } from "../provider-kinds.ts";
import { upstreamSessionId } from "../upstream-session.ts";
import { zcodeChat } from "../zcode/transport.ts";
import { zcodeMaxOutput } from "../zcode/models.ts";
import {
  miniMaxApiBusinessCode,
  miniMaxApiChat,
  miniMaxApiTenants,
  peekMiniMaxApiStream,
  MiniMaxApiBusinessError,
} from "../minimax/api.ts";
import {
  tokenRhythmChat,
  TokenRhythmBusyError,
  TokenRhythmNoBalanceError,
} from "../tokenrhythm/transport.ts";
import { senseNovaChat } from "../sensenova/transport.ts";
import { internAiChat } from "../intern-ai/transport.ts";
import { gatewayErrorMessage, minimaxChat, PING_MS } from "../minimax/transport.ts";
import {
  deliverAnthropicStream,
  deliverJson,
  deliverOpenAIChunks,
  deliverOpenAIStream,
  type Dialect,
} from "./deliver.ts";
import {
  byOrder,
  classifyUpstreamError,
  describeUpstreamError,
  isDegradableUpstreamError,
  isNoBalanceFailure,
  selectProvider,
  type ProviderPolicy,
} from "./provider-selection.ts";
import { businessCodeOf, upstreamStatusOf, withBusinessCode, withUpstreamStatus } from "../upstream-status.ts";
import { accountsOfPlatform, provider, type ProviderRow } from "../providers.ts";
import { platformOf, platformPolicy } from "../platforms.ts";
import { platformWithoutAccount, upstreamModel, type Route } from "./routes.ts";

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
  /** How often a queued legacy request is tried again. */
  legacyMaxAttempts: number;
  legacyRetryMs: number;
  /** How often a failed new-protocol request is tried again. */
  qoderMaxAttempts: number;
  /** How often a busy relay is tried again, on the same account. */
  tokenRhythmMaxAttempts: number;
  /** Whether a request is written to the log. */
  logRoute: boolean;
  /**
   * The client's session headers, for the open API platforms.
   *
   * The simulated clients (Qoder, WorkBuddy, MiniMax Code, ZCode) rebuild the
   * request the way the desktop client builds it — only the fields they need,
   * everything else in the client's headers is ignored. The open platforms get
   * the request as it is, so the session headers go along.
   */
  clientHeaders: Record<string, string>;
  /**
   * The client's session id, as the client spelled it.
   *
   * The simulated clients rebuild the request the way the desktop client builds
   * it, and the desktop client sends *its own* session id. The clients here
   * spell their session ids differently (pi sends a bare UUID, opencode sends
   * `ses_…`), so the upstream id is mapped from this one (lib/upstream-session.ts).
   * Empty when the client sent no session id.
   */
  clientSessionId?: string;
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
 * The error for an upstream that answered with a status of its own.
 *
 * The client sees the gateway's status, and the upstream's own status and
 * code stay on the error: they say whether another account would do better
 * (a 402 means this account is out of credit, a 400 means the request is
 * wrong and every account would fail the same way).
 */
function upstreamStatusError(status: number, text: string, what: string): AuthError {
  const error = new AuthError(
    `upstream HTTP ${status}`,
    `${what}上游返回 ${status}：${text.slice(0, 300)}`,
    502,
  );
  withUpstreamStatus(error, status);
  const code = businessCodeOfBody(text);
  if (code !== null) withBusinessCode(error, code);
  return error;
}

/**
 * 平台自己的码（如果错误信封里有）。
 *
 * 状态码说的是「这个请求被拒了」，业务码说的是「为什么」：墨点用完
 * （quota_exceeded）与限流（rate_limit_exceeded）都是 429，换一个账号的结果
 * 却不一样。
 */
function businessCodeOfBody(text: string): number | string | null {
  try {
    const parsed = text ? JSON.parse(text) : null;
    const code = parsed?.error?.code ?? parsed?.code ?? null;
    if (typeof code === "string" && code.trim()) return code.trim();
    if (typeof code === "number" && Number.isFinite(code)) return code;
    return null;
  } catch {
    return null;
  }
}

/**
 * The platform's accounts that can serve a request, in weight order.
 *
 * An account that is turned off is not a candidate: it is not "this account
 * failed", it is "this platform has one fewer account right now".
 */
function servingAccounts(platform: string): ProviderRow[] {
  return accountsOfPlatform(platform).filter((row) => row.enabled);
}

/**
 * 这个失败对客户端意味着什么。
 *
 * 客户端看的是网关的状态，不是上游的：网关自己的 401 是「网关的 key 不对」，
 * 上游的 401 是「这把 key 被上游拒了」，两件事不能撞在同一个状态码上。所以
 * 上游的租户级错误分三档报给客户端：
 *
 *   1. 余额真的用完了（上游 402，或者 MiniMax 的业务码 1008）→ 402，提示说
 *      充值后恢复。那是客户端唯一能动手的一件事。
 *   2. 别的租户级错误（凭据被拒、配额打满、额度用尽的业务码）→ 503。这是
 *      网关的凭据或配额问题，客户端无从处理；提示里带上游的状态与原文。
 *   3. 请求本身的问题（上游 400/404/413）→ 原样抛出去：传输层已经报成 502，
 *      提示里带着上游的原文。
 *
 * 换掉状态码之后，上游自己的状态与业务码仍留在错误上（withUpstreamStatus /
 * withBusinessCode）：日志与分类器要能看出真实发生了什么。
 */
function accountFailure(
  lastError: unknown,
  noBalance: { message: string; hint: string },
): Error {
  if (isNoBalanceFailure(lastError)) {
    const trace = lastError instanceof TokenRhythmNoBalanceError ? lastError.traceId : "";
    const detail = lastError instanceof Error ? lastError.message : "";
    const error = new AuthError(
      noBalance.message,
      `${noBalance.hint}${detail ? ` ${detail}` : ""}${trace ? ` traceId=${trace}` : ""}`,
      402,
    );
    return keepUpstreamTruth(error, lastError);
  }
  const tenant = tenantLevelFailure(lastError);
  if (tenant) {
    // 网关自己的 503：凭据或配额的问题，客户端处理不了。
    const error = new AuthError(tenant.message, tenant.hint, 503);
    if (tenant.type) error.type = tenant.type;
    return keepUpstreamTruth(error, lastError);
  }
  if (lastError instanceof Error) return lastError;
  return new AuthError(noBalance.message, noBalance.hint, 502);
}

/**
 * 租户级错误：这个账号接不了这个请求，客户端也无从处理。
 *
 * 凭据被拒、配额打满、额度用尽 —— 都是网关这边要处理的事，所以客户端看到
 * 503；上游的状态与原文写进提示里，排查时不用猜。
 */
function tenantLevelFailure(
  error: unknown,
): { message: string; hint: string; type?: string } | null {
  const kind = classifyUpstreamError(error).kind;
  if (kind !== "credential" && kind !== "rate-limit" && kind !== "quota") return null;
  const status = upstreamSaidStatus(error);
  const code = businessCodeOf(error);
  const said = [
    status === null ? null : `上游 HTTP ${status}`,
    code === null ? null : `业务码 ${code}`,
  ].filter((part): part is string => part !== null);
  const because = said.length ? `（${said.join("，")}）` : "";
  // The code goes into the message too: a client that reads only
  // error.message still sees which failure it was.
  return {
    message: `upstream account cannot serve the request${because}`,
    hint:
      `网关这边的账号接不了这个请求${because}：${upstreamDetail(error)}。` +
      "凭据或配额是网关这边的事，客户端处理不了；等网关换好账号或额度恢复后再试。",
    // The client reads the type too. A refused credential keeps the type the
    // rest of the gateway uses for a credential problem (the 503 default),
    // and the two quota-ish ones say what they are.
    type: kind === "rate-limit" ? "rate_limit_error" : kind === "quota" ? "usage_limit_error" : undefined,
  };
}

/**
 * 上游自己回过的状态，写进提示里。
 *
 * upstreamStatusOf 会退回到错误上的 status 字段：对 MiniMaxApiTenantError
 * 那是上游的状态（401/402/429），但 AuthError 的 status 是网关给客户端看的
 * 那个（502/503），把它当「上游回了什么」会写错。只有传输层明确放上去的
 * upstreamStatus 才是上游真的回过的状态。
 */
function upstreamSaidStatus(error: unknown): number | null {
  const status = upstreamStatusOf(error);
  if (status === null) return null;
  if (error instanceof AuthError && (error as { upstreamStatus?: unknown }).upstreamStatus === undefined) {
    return null;
  }
  return status;
}

/** 上游自己说的话：错误里的原文。 */
function upstreamDetail(error: unknown): string {
  if (error instanceof AuthError) return error.hint || error.message;
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

/**
 * 把上游的状态与业务码留在新错误上。
 *
 * 换了状态码之后，日志与分类器还要能看出真实发生了什么：上游 401 仍然是
 * 上游 401，不是网关的 503。
 */
function keepUpstreamTruth<T extends object>(error: T, original: unknown): T {
  const status = upstreamStatusOf(original);
  if (status !== null) withUpstreamStatus(error, status);
  const code = businessCodeOf(original);
  if (code !== null) withBusinessCode(error, code);
  return error;
}

/**
 * Run one upstream call on one of the platform's accounts, under its policy.
 *
 * `single` uses the first account that is on and never moves; `fallback` hands
 * the request to the next account when this one cannot serve it; the account
 * that is refused a request that is itself wrong is not left behind — another
 * account would fail the same way.
 *
 * `expiry_first` is the relay station's alone: its order comes from the
 * wallet, so it has its own adapter (toTokenRhythm) and never reaches here.
 */
async function underPolicy<T>(
  platform: string,
  what: string,
  run: (account: ProviderRow) => Promise<T>,
): Promise<T> {
  const accounts = accountsOfPlatform(platform);
  const serving = accounts.filter((row) => row.enabled);
  if (!serving.length) throw platformWithoutAccount(platform, accounts.length);
  const policy = platformPolicy(platform);
  const candidates = byOrder(
    serving.map((account) => ({ id: account.id, weight: account.weight, run: () => run(account) })),
  );
  return selectProvider(policy, candidates, {
    degradable: isDegradableUpstreamError,
    onAttempt: (candidate, error) => {
      if (!error) return;
      const moves = isDegradableUpstreamError(error);
      const at = candidates.findIndex((c) => c.id === candidate.id);
      const next = moves && policy === "fallback" ? candidates[at + 1]?.id : undefined;
      console.log(
        `[ROUTE] ${what} account=${candidate.id} cannot serve it (${describeUpstreamError(error)})` +
          (next ? `, trying ${next}` : moves && policy === "fallback" ? ", no account left" : ", not switching"),
      );
    },
    // The caller sees the error the upstream produced, not a new one.
    failure: (lastError) =>
      lastError instanceof Error ? lastError : new AuthError("upstream failed", "上游没有响应。", 502),
  });
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
  body: Record<string, unknown>,
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
  const { response } = await underPolicy(route.platform, "workbuddy", (account) =>
    workbuddyChat(openaiBody, {
      providerId: account.id,
      stream,
      conversationId,
      model: ctx.workbuddyModel(model),
    }),
  );

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
  if (model && qoderProtocolForRegion(model, region) === "legacy") {
    await toQoderLegacy(ctx, openaiBody, model, dialect, stream, out, region, route.label, route.platform);
    return;
  }

  openaiBody.model = key;
  // The official client sends the limit from its own catalog, whatever the
  // caller asked for; the gateway ignores it and cuts the answer at the
  // model's real limit.
  openaiBody.max_tokens = QODER_CLIENT_MAX_TOKENS;
  const upstream = await underPolicy(route.platform, "qoder", (account) =>
    qoderWithRetry(
      () => qoderChatCompletion(openaiBody, { stream, providerId: account.id, region }),
      ctx.qoderMaxAttempts,
    ),
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
  openaiBody: Record<string, unknown>,
  model: QoderModel,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
  region: QoderRegion,
  label?: string,
  platform = "qoder",
): Promise<void> {
  const chunks = await underPolicy(platform, "qoder", async (account) =>
    legacyWithRetry(
      () =>
        legacyChatCompletion(
          {
            messages: Array.isArray(openaiBody.messages) ? openaiBody.messages : [],
            tools: Array.isArray(openaiBody.tools) ? openaiBody.tools : undefined,
            modelKey: model.key,
            displayName: model.name,
            // The same number the simulated client sends.
            maxTokens: QODER_CLIENT_MAX_TOKENS,
            reasoning: model.reasoning,
            contextWindow: model.context,
          },
          { providerId: account.id, region },
        ),
      ctx.legacyMaxAttempts,
      ctx.legacyRetryMs,
    ),
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
): AsyncGenerator<Json> {
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

export async function toMinimax(
  ctx: UpstreamContext,
  body: Record<string, unknown>,
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
    r = await underPolicy(route.platform, "minimax", (account) => minimaxChat(anthropicBody, account.id));
  } catch (e) {
    // 换掉错误对象会把上游自己的状态与业务码丢掉，日志与分类器就看不出
    // 真实发生了什么。
    const err = e as AuthError;
    throw keepUpstreamTruth(new AuthError(err.message, err.hint, err.status, err.type), e);
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
 * MiniMax 开放平台，按 API Key 分租户。
 *
 * 平台说的是 OpenAI 方言，所以 Anthropic 的请求在方言层转过去（跟别的
 * 上游一样）。哪个租户出钱由上游自己的策略定：单一只调一把 key，降级按 key
 * 的次序换下一个。
 */
export async function toMiniMaxApi(
  ctx: UpstreamContext,
  body: Record<string, unknown>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  const model = upstreamModel(route);
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  openaiBody.model = model;
  openaiBody.stream = stream;

  // 一个账号可以有不止一把 key，所以候选是「账号 × key」：账号之间按策略
  // 换，账号自己名下的 key 也按同一个策略换。
  const accounts = accountsOfPlatform(route.platform);
  const serving = accounts.filter((row) => row.enabled);
  if (!serving.length) throw platformWithoutAccount(route.platform, accounts.length);
  const policy = platformPolicy(route.platform);
  const slots = serving.flatMap((account) =>
    miniMaxApiTenants(account.id).map((tenant) => ({ account, tenant })),
  );
  if (!slots.length) {
    throw new AuthError(
      "no minimax api key is configured",
      "MiniMax 开放平台的账号都还没有 API Key。在面板上给账号配一把。",
      503,
    );
  }

  const ids = slots.map(({ account, tenant }) => `${account.id}#${tenant.index}`);
  const candidates = byOrder(
    slots.map(({ account, tenant }, position) => ({
      id: ids[position],
      // 权重是账号的：一个账号下几把 key 谁先，按 key 的次序。
      weight: account.weight,
      run: async () => {
        if (ctx.logRoute) {
          console.log(
            `[ROUTE] minimax-api model=${route.model} policy=${policy} account=${account.id} key=${tenant.index} stream=${stream}`,
          );
        }
        const response = await miniMaxApiChat(tenant, openaiBody, "cn", ctx.clientHeaders);
        if (stream) {
          // 平台有时候用 200 回答一个失败的请求；流式的失败在第一个帧里。
          // 在写给客户端之前看：答复还没开始，换一把 key 还来得及。
          return { response: await peekMiniMaxApiStream(response), json: null as any };
        }
        const json = await response.json();
        // 平台有时用 200 回答一个失败的请求（base_resp.status_code 不为 0）。
        // 那不是答复，交给客户端会让它以为答完了。
        const code = miniMaxApiBusinessCode(json);
        if (code !== null) {
          throw new MiniMaxApiBusinessError(code, String(json?.base_resp?.status_msg ?? ""));
        }
        return { response, json };
      },
    })),
  );

  const result = await selectProvider(policy, candidates, {
    degradable: isDegradableUpstreamError,
    onAttempt: (candidate, error) => {
      if (!error) return;
      const at = ids.indexOf(candidate.id);
      // 只有真的要换才说「试下一个」：不可降级的错误就地抛出去。
      const moves = isDegradableUpstreamError(error);
      const next = moves && policy === "fallback" ? ids[at + 1] : undefined;
      console.log(
        `[ROUTE] minimax-api ${candidate.id} cannot serve it (${describeUpstreamError(error)})` +
          (next ? `, trying ${next}` : moves && policy === "fallback" ? ", no key left" : ", not switching"),
      );
    },
    failure: (lastError) =>
      accountFailure(lastError, {
        message: "no minimax api account can serve the request",
        hint: "MiniMax 开放平台的账号都没有额度了（402 余额不足）。充值后恢复。",
      }),
  });

  if (!stream) {
    deliverJson(out, dialect, "openai", result.json, route.label ?? model, ctx.onUsage);
    return;
  }
  await deliverOpenAIStream(out, result.response.body!, dialect, route.label ?? model, undefined, ctx.onUsage);
}

/**
 * ZCode（智谱）。
 *
 * 上游说的是 Anthropic 方言，所以 Anthropic 的请求原样过去，OpenAI 的转成
 * Anthropic 再转回来 —— 跟别的上游一个做法。
 */
export async function toZcode(
  ctx: UpstreamContext,
  body: Record<string, unknown>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  const model = upstreamModel(route);
  const anthropicBody =
    dialect === "anthropic" ? { ...body } : openaiToAnthropic(body, zcodeMaxOutput(model));
  anthropicBody.model = model;
  anthropicBody.stream = stream;

  // The upstream's session id: the client's session id, mapped to the shape the
  // upstream expects. The same client session always maps to the same id.
  const sessionId = upstreamSessionId(route.platform, ctx.clientSessionId ?? "");

  const { response } = await underPolicy(route.platform, "zcode", (account) =>
    zcodeChat(anthropicBody, {
      effort: effortOf(body),
      providerId: account.id,
      sessionId,
    }),
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw upstreamStatusError(response.status, text, "ZCode ");
  }

  if (!stream) {
    const json = await response.json();
    deliverJson(out, dialect, "anthropic", json, route.label ?? model, ctx.onUsage);
    return;
  }
  await deliverAnthropicStream(out, response.body!, dialect, route.label ?? model, 0, ctx.onUsage);
}

/**
 * The accounts of a TokenRhythm platform, in the order the policy wants them.
 *
 * `expiry_first` asks the wallet: the gift that runs out first is spent
 * first. The other policies take the accounts in the order they were added.
 */
export function tokenRhythmAccounts(
  statuses: TokenRhythmAccountStatus[],
  policy: ProviderPolicy,
): TokenRhythmAccountStatus[] {
  // expiry_first：按到期重排——赠金先上（快到期的先），本金最后。
  // single 与 fallback：按权重（账号行的次序），跟其它上游一个样。
  if (policy === "expiry_first") return orderedAccounts(statuses);
  return usableAccounts(statuses);
}

/**
 * TokenRhythm, the relay station.
 *
 * The upstream speaks the OpenAI dialect, so a request in that dialect goes
 * out nearly unchanged and the answer comes back the same way. An Anthropic
 * request is converted first.
 *
 * Which account pays for it is decided by the platform's policy: the gift
 * money expires, so the gift that runs out first is spent first (that is
 * `expiry_first`), and the other policies take the accounts in the order they
 * were added. An account that says it has no money left cannot serve the
 * request at all, so the next one takes it — the busy case is different:
 * there the request is retried on the same account, so the prompt cache
 * stays warm and the balance is not eaten by a cold cache. When those retries
 * are used up the account cannot serve the request at this moment either, so
 * it is counted as a 5xx and the next one takes it.
 *
 * A TokenRhythm account is a row of the provider table: its own cookie reads
 * its own wallet, and its own key calls the models.
 */
export async function toTokenRhythm(
  ctx: UpstreamContext,
  body: Record<string, unknown>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  const model = upstreamModel(route);
  openaiBody.model = model;
  openaiBody.stream = stream;

  const platform = route.platform;
  const policy = platformPolicy(platform);
  // 这一类上游自己的钩子：余额到期优先用它判断「余额不足」。
  const missingBalance =
    kindOf(platformOf(platform)?.kind ?? "")?.isRequestMissingBalance ?? isNoBalanceFailure;

  const candidateFor = (accountId: string) => ({
    id: accountId,
    weight: 0,
    run: async () => {
      if (ctx.logRoute) {
        console.log(
          `[ROUTE] tokenrhythm model=${route.model} policy=${policy} account=${accountId} stream=${stream}`,
        );
      }
      let response: Response;
      try {
        const call = await tokenRhythmChatWithRetry(
          accountId,
          openaiBody,
          ctx.tokenRhythmMaxAttempts,
          ctx.clientHeaders,
        );
        response = call.response;
      } catch (e) {
        // The platform said this account has no money left: it is put aside
        // for a while, and the balances are scanned again so that another
        // account is pinned.
        if (missingBalance(e)) {
          markAccountOutOfMoney(accountId);
          resetTokenRhythmStatusCache(platform);
        }
        throw e;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw upstreamStatusError(response.status, text, "TokenRhythm ");
      }
      return { response, accountId };
    },
  });

  // expiry_first 的重排逻辑：钉住的那个账户（定时扫描时定的：赠金最先到期的
  // 那个）接这个请求。它说余额不足时，钩子重新扫描、重新钉一个别的接手。
  const nextByBalance = async () => {
    const balance = pinnedBalanceAccount(platform) ?? (await setBalanceAccount(platform));
    if (!balance) return null;
    return candidateFor(balance.accountId);
  };

  const statuses = await tokenRhythmStatuses(platform);
  const accounts = policy === "expiry_first" ? [] : tokenRhythmAccounts(statuses, policy);
  if (policy !== "expiry_first" && !accounts.length) {
    // 「没配好」和「没钱了」是两回事：前者要人去面板填账号密码，后者要充值。
    // 混成一句话，人就会去充值解决一个填表的问题。
    const configured = statuses.filter((s) => s.hasKey || s.credential);
    if (!configured.length) {
      throw new AuthError(
        "no tokenrhythm account is set up",
        "TokenRhythm 的账号还没有配好：在面板的「上游」页给它填上账号密码（查余额用）和 API key（发请求用）。",
        503,
      );
    }
    throw new AuthError(
      "no tokenrhythm account has credit left",
      "TokenRhythm 的账号都没有余额了（402 余额不足）。充值后恢复。",
      402,
    );
  }

  const ids = accounts.map((account) => account.accountId);
  const candidates = byOrder(
    accounts.map((account) => ({
      id: account.accountId,
      weight: provider(account.accountId)?.weight ?? 0,
      run: candidateFor(account.accountId).run,
    })),
  );

  const result = await selectProvider(policy, candidates, {
    degradable: isDegradableUpstreamError,
    // The hook of expiry_first: only "no money left" moves on.
    insufficient: missingBalance,
    next: policy === "expiry_first" ? nextByBalance : undefined,
    // 余额不足时钩子重新扫描余额，重新钉一个账户。
    onMissingBalance: async () => {
      await setBalanceAccount(platform);
    },
    onAttempt: (candidate, error) => {
      if (!error) return;
      // 只有真的要换才说「试下一个」：不可降级的错误就地抛出去。
      const moves =
        policy === "expiry_first"
          ? isNoBalanceFailure(error)
          : isDegradableUpstreamError(error);
      // expiry_first 的「下一个」由重新扫描决定，这里说不出是谁 —— 那就说
      // 正在重新扫描。名单为空时按顺序找也只能得出「没有下一个」，那是错的。
      const at = ids.indexOf(candidate.id);
      let suffix = ", not switching";
      if (policy === "expiry_first") {
        if (moves) suffix = ", rescanning the balances";
      } else if (policy === "fallback") {
        const next = moves ? ids[at + 1] : undefined;
        if (next) suffix = `, trying ${next}`;
        else if (moves) suffix = ", no account left";
      }
      console.log(
        `[ROUTE] tokenrhythm account=${candidate.id} cannot serve it (${describeUpstreamError(error)})${suffix}`,
      );
    },
    failure: (lastError, tried) =>
      accountFailure(lastError, {
        message: "no tokenrhythm account has credit left",
        hint:
          tried.length > 1
            ? `TokenRhythm 的 ${tried.length} 个账号都试过了，都没余额了（402 余额不足）。充值后恢复。`
            : "TokenRhythm 的这个账号没有余额了（402 余额不足），但网关只试了这一个——把上游的生效策略改成「降级」，别的账号就能接手。充值后恢复。",
      }),
  });

  const { response, accountId } = result;
  if (!stream) {
    const json = await response.json();
    const reason = json?.choices?.[0]?.finish_reason;
    if (reason === "length") noteTruncation(openaiBody, model, accountId);
    deliverJson(out, dialect, "openai", json, route.label ?? model, ctx.onUsage);
    return;
  }

  await deliverOpenAIStream(out, response.body!, dialect, route.label ?? model, (reason) => {
    if (reason === "length") noteTruncation(openaiBody, model, accountId);
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
function noteTruncation(body: Record<string, unknown>, model: string, accountId: string): void {
  const asked = typeof body.max_tokens === "number" ? body.max_tokens : null;
  console.log(
    `[TRUNCATED] model=${model} account=${accountId} asked_for=${asked ?? "unset"} tokens — ` +
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
 *
 * When the retries are used up the account cannot serve the request at this
 * moment either, so it is reported as a 5xx: the policy decides what happens
 * next (in `fallback` the next account takes it).
 */
async function tokenRhythmChatWithRetry(
  accountId: string,
  body: Record<string, unknown>,
  maxAttempts: number,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; key: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await tokenRhythmChat(accountId, body, extraHeaders);
    } catch (e) {
      if (e instanceof TokenRhythmBusyError && attempt < maxAttempts) {
        console.log(
          `[ROUTE] tokenrhythm busy on ${accountId} (${e.traceId || e.message}), ` +
            `retry ${attempt}/${maxAttempts - 1} in ${e.retryAfterSec}s`,
        );
        await new Promise((r) => setTimeout(r, e.retryAfterSec * 1000));
        continue;
      }
      if (e instanceof TokenRhythmBusyError) {
        throw new AuthError(
          "tokenrhythm is busy",
          `TokenRhythm 现在繁忙（${e.message}）。这是上游的临时状态，稍后重试即可；` +
            `同一个账号上已经重试过 ${Math.max(maxAttempts - 1, 0)} 次，还是这个排队。` +
            `${e.traceId ? `traceId=${e.traceId}` : ""}`.trim(),
          503,
          "api_error",
        );
      }
      throw e;
    }
  }
}

/**
 * 开放平台的推理（OpenAI 方言）。
 *
 * SenseNova 与书生·端砚说的是同一种方言：请求几乎原样发过去，答案也原样回来，
 * 鉴权是一把账号上的推理 key。两个上游的差别只有三样：路由日志里的名字、
 * 错误提示里怎么称呼它、以及推理怎么发 —— 所以差别都由调用方传进来。
 */
async function toOpenAiPlatform(
  ctx: UpstreamContext,
  body: Record<string, unknown>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
  opts: {
    /** 路由日志里的名字。 */
    log: string;
    /** 错误提示里怎么称呼它（后面接「上游返回 …」）。 */
    what: string;
    /** 推理怎么发；第二个参数是这个账号的 id（凭据按账号取）。 */
    chat: (
      openaiBody: Record<string, unknown>,
      headers: Record<string, string>,
      accountId: string,
    ) => Promise<Response>;
  },
): Promise<void> {
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  const model = upstreamModel(route);
  openaiBody.model = model;
  openaiBody.stream = stream;
  if (ctx.logRoute) {
    console.log(`[ROUTE] ${opts.log} model=${route.model} stream=${stream}`);
  }

  const response = await underPolicy(route.platform, opts.log, (account) =>
    opts.chat(openaiBody, ctx.clientHeaders, account.id),
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw upstreamStatusError(response.status, text, opts.what);
  }

  if (!stream) {
    const json = await response.json();
    deliverJson(out, dialect, "openai", json, route.label ?? model, ctx.onUsage);
    return;
  }

  await deliverOpenAIStream(out, response.body!, dialect, route.label ?? model, undefined, ctx.onUsage);
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
  body: Record<string, unknown>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  await toOpenAiPlatform(ctx, body, route, dialect, stream, out, {
    log: "sensenova",
    what: "SenseNova ",
    chat: (openaiBody, headers, accountId) => senseNovaChat(openaiBody, accountId, headers),
  });
}

/**
 * 书生·端砚（Discovery 子站）。
 *
 * 与 SenseNova 一样是 OpenAI 方言：请求原样发过去，答案原样回来。
 */
export async function toInternAi(
  ctx: UpstreamContext,
  body: Record<string, unknown>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
): Promise<void> {
  await toOpenAiPlatform(ctx, body, route, dialect, stream, out, {
    log: "intern-ai",
    what: "书生·端砚",
    chat: (openaiBody, headers, accountId) => internAiChat(openaiBody, accountId, headers),
  });
}
