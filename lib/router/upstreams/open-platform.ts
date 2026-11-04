// lib/router/upstreams/open-platform.ts — the open platforms.
//
// SenseNova and 书生·端砚 speak the same dialect and differ only in the
// name the log uses, how the message names them, and how the call is
// made — so the difference is passed in.

import type Koa from "koa";
import { AuthError } from "../../credential.ts";
import { anthropicToOpenAI, openaiToAnthropic } from "../../dialect/request.ts";
import { senseNovaChat } from "../../sensenova/transport.ts";
import { internAiChat } from "../../intern-ai/transport.ts";
import { deliverAnthropicStream, deliverJson, deliverOpenAIStream, type Dialect } from "../deliver.ts";
import { upstreamModel, type Route } from "../routes.ts";
import { retryAfterMs } from "../../upstream-status.ts";
import { type UpstreamContext, settlement, upstreamStatusError, underPolicy } from "./policy.ts";

/**
 * 开放平台的推理（OpenAI 方言）。
 *
 * SenseNova 与书生·端砚说的是同一种方言：请求几乎原样发过去，答案也原样回来，
 * 鉴权是一把账号上的推理 key。两个上游的差别只有三样：路由日志里的名字、
 * 错误提示里怎么称呼它、以及推理怎么发 —— 所以差别都由调用方传进来。
 */
export async function toOpenAiPlatform(
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

  // 流式答复是在 underPolicy 返回之后才消费的：冷却由调用方在流结束时结算。
  const settle = settlement();
  const response = await underPolicy(
    route.platform,
    opts.log,
    async (account) => {
      const res = await opts.chat(openaiBody, ctx.clientHeaders, account.id);
      if (res.ok) return res;
      // 上游拒了：那是账号的失败（能降级的才记冷却），不是答复到手。冷却由策略
      // 记（onAttempt），这里只负责把错误造出来。
      //
      // 错误在这里造（而不是等 underPolicy 回来再造）：策略才知道这个失败等不
      // 等得起 —— TPM 类限流等得起就自己等，重试同一个账号（见
      // lib/router/upstreams/policy.ts 的 runWithRateWait）。上游说的
      // retry-after 也在这里读出来挂到错误上。
      const text = await res.text().catch(() => "");
      throw upstreamStatusError(res.status, text, opts.what, retryAfterMs(res) ?? undefined);
    },
    settle,
    ctx.availability,
  );

  if (!stream) {
    const json = await response.json();
    deliverJson(out, dialect, "openai", json, route.label ?? model, ctx.onUsage);
    settle.success();
    return;
  }

  try {
    await deliverOpenAIStream(
      out,
      response.body!,
      dialect,
      route.label ?? model,
      undefined,
      ctx.onUsage,
      (e) => settle.failure(e),
    );
    settle.success();
  } catch (e) {
    settle.failure(e);
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * 上游讲 Anthropic Messages 的开放平台
 * ------------------------------------------------------------------ */

/**
 * 客户端没说输出上限时发给上游的那个数。
 *
 * Anthropic 的 Messages 报文要求必有 max_tokens，不填上游直接 400。这一类平台
 * 的目录是空的（这一单不播种），所以没有「模型自己的上限」可问 —— 只能给一个
 * 保守的数。宁可截短也不送一个把上游额度一次吃光的数。
 */
const ANTHROPIC_PLATFORM_DEFAULT_MAX_TOKENS = 8192;

/** 上游要的那个协议版本头。换成别的日期，行为会跟着变。 */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 流式答复中间的心跳间隔（毫秒）。
 *
 * 与 minimax 那一类同一个理由：上游长思考时一个字节都不发，客户端会以为连接
 * 死了（有的客户端会自己重连，等于再送一份请求出去）。0 是关掉心跳 —— 这里
 * 不能关，这条路上游真的会停下来想很久。
 */
const PING_MS = 15_000;

/**
 * 推理地址：`{base}/v1/messages`。
 *
 * 用户填的 base 里可能已经带了 `/v1`（面板上照着 OpenAI 那一类填的，那边就是
 * `…/v1`）。直接拼会拼出 `/v1/v1/messages`，所以先看最后一段。
 *
 * 地址是平台行上的数据，写入时校验过一次（lib/open-platforms.ts 的
 * checkBaseUrl），但库里可能有更早写下的行 —— 出去之前再判一次协议：只许
 * http/https，别的协议一个请求也不发。
 */
function anthropicMessagesUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new AuthError(
      "the platform has no usable base url",
      `这个平台的地址不是完整的网址（${base}），发不出请求。在面板上改一下地址。`,
      500,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AuthError(
      "the platform base url is not http(s)",
      `这个平台的地址只能走 http 或 https（现在是 ${url.protocol}），请求不会发出去。`,
      500,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? `${path}/messages` : `${path}/v1/messages`;
  return url.toString();
}

/**
 * 发一个请求到 Anthropic 兼容的推理端点。
 *
 * 鉴权按 Anthropic 的约定：`x-api-key` 加上 `anthropic-version`，**不是**
 * `Authorization: Bearer`。发错了上游回的是鉴权失败，看着像 key 不对，其实
 * 是头不对。
 */
export async function anthropicPlatformChat(
  platform: { id: string; label: string; base: string; key: string },
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  if (!platform.key) {
    throw new AuthError(
      `${platform.id} has no inference key`,
      `${platform.label} 账号上没有推理用的 API key。请在面板上填一把。`,
      500,
    );
  }
  const endpoint = anthropicMessagesUrl(platform.base);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      // 客户端的会话头先放，鉴权与内容类型后放：会话头能跟着过去，但不能把
      // 这三样顶掉（顶掉了这把 key 就白配了）。
      ...extraHeaders,
      "content-type": "application/json",
      "x-api-key": platform.key,
      "anthropic-version": ANTHROPIC_VERSION,
      Accept: body.stream ? "text/event-stream" : "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; buddy-proxy)",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status === 401) {
    // 401 是**这个账号**接不了：必须带上上游的状态码，策略层才看得见（能降级
    // 的换下一个账号，single 的记冷却，面板上那个账号才显示不可用）。
    //
    // 不带上就会读成「上游 502」（AuthError 的 status 是给客户端看的那个数），
    // 而 5xx 不算账号的错：冷却不记，面板上这个账号一直写着可用。
    const text = await response.text().catch(() => "");
    throw upstreamStatusError(401, text, `${platform.label} `);
  }
  return response;
}

/**
 * 开放平台的推理（Anthropic 方言）。
 *
 * 与 toOpenAiPlatform 是一对：那边上游讲 OpenAI，这边上游讲 Anthropic
 * Messages。转的只有请求与答复的形状 —— 冷却、降级、限流等待、结算全都走同一
 * 套（underPolicy / settlement / upstreamStatusError / retryAfterMs）。
 *
 * 下游本来就是 anthropic 时请求原样发：多转一次会把 system、cache_control
 * 这些 Anthropic 自己的东西转丢，而上游其实认得它们。
 */
export async function toAnthropicPlatform(
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
    /** 推理怎么发；第三个参数是这个账号的 id（凭据按账号取）。 */
    chat: (
      anthropicBody: Record<string, unknown>,
      headers: Record<string, string>,
      accountId: string,
    ) => Promise<Response>;
  },
): Promise<void> {
  const anthropicBody: Record<string, unknown> =
    dialect === "anthropic"
      ? { ...body }
      : (openaiToAnthropic(body, ANTHROPIC_PLATFORM_DEFAULT_MAX_TOKENS) as Record<string, unknown>);
  const model = upstreamModel(route);
  anthropicBody.model = model;
  anthropicBody.stream = stream;
  // 生效上限：客户端给了就是它的，没给才是上面那个默认值。日志拿它算用掉多少。
  if (typeof anthropicBody.max_tokens === "number") ctx.upstreamMaxTokens = anthropicBody.max_tokens;
  if (ctx.logRoute) {
    console.log(`[ROUTE] ${opts.log} model=${route.model} stream=${stream}`);
  }

  // 流式答复是在 underPolicy 返回之后才消费的：冷却由调用方在流结束时结算。
  const settle = settlement();
  const response = await underPolicy(
    route.platform,
    opts.log,
    async (account) => {
      const res = await opts.chat(anthropicBody, ctx.clientHeaders, account.id);
      if (res.ok) return res;
      // 上游拒了：那是账号的失败（能降级的才记冷却），不是答复到手。错误在这里
      // 造出来，策略才看得到上游的状态与 retry-after。
      const text = await res.text().catch(() => "");
      throw upstreamStatusError(res.status, text, opts.what, retryAfterMs(res) ?? undefined);
    },
    settle,
    ctx.availability,
  );

  if (!stream) {
    const json = await response.json();
    deliverJson(out, dialect, "anthropic", json, route.label ?? model, ctx.onUsage);
    settle.success();
    return;
  }

  try {
    await deliverAnthropicStream(
      out,
      response.body!,
      dialect,
      route.label ?? model,
      PING_MS,
      ctx.onUsage,
      (e) => settle.failure(e),
    );
    settle.success();
  } catch (e) {
    // 中途断的流：那个账号要记冷却，而且原来那行冷却不能被清掉。
    settle.failure(e);
    throw e;
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
