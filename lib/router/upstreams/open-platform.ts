// lib/router/upstreams/open-platform.ts — the open platforms.
//
// SenseNova and 书生·端砚 speak the same dialect and differ only in the
// name the log uses, how the message names them, and how the call is
// made — so the difference is passed in.

import type Koa from "koa";
import { anthropicToOpenAI } from "../../dialect/request.ts";
import { senseNovaChat } from "../../sensenova/transport.ts";
import { internAiChat } from "../../intern-ai/transport.ts";
import { deliverJson, deliverOpenAIStream, type Dialect } from "../deliver.ts";
import { upstreamModel, type Route } from "../routes.ts";
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
    (account) => opts.chat(openaiBody, ctx.clientHeaders, account.id),
    settle,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = upstreamStatusError(response.status, text, opts.what);
    // 上游拒了：那是账号的失败（能降级的才记冷却），不是答复到手。
    settle.failure(error);
    throw error;
  }

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
