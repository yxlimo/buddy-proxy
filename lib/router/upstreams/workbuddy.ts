// lib/router/upstreams/workbuddy.ts — WorkBuddy, the China region.

import type Koa from "koa";
import { AuthError } from "../../credential.ts";
import { anthropicToOpenAI } from "../../dialect/request.ts";
import { workbuddyChat, aggregateStream, conversationIdFor } from "../../workbuddy/transport.ts";
import { ClientGoneError } from "../deliver.ts";
import { deliverJson, deliverOpenAIStream, type Dialect } from "../deliver.ts";
import { upstreamModel, type Route } from "../routes.ts";
import { asClientGone, watchClientGone } from "./client-gone.ts";
import { type UpstreamContext, settlement, underPolicy } from "./policy.ts";

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
    // 记下真正发出去的上限：日志要拿它和 reasoning 一起看。
    ctx.upstreamMaxTokens = openaiBody.max_tokens;
  }
  if (ctx.logRoute) {
    console.log(`[ROUTE] workbuddy model=${route.model} stream=${stream}`);
  }

  // The conversation keeps its id for every turn, so the upstream can see
  // that the turns belong together.
  const conversationId = conversationIdFor(openaiBody.messages, openaiBody.conversation_id);
  // 流式答复是在 underPolicy 返回之后才消费的：冷却由调用方在流结束时结算。
  const settle = settlement();
  // 客户端走了就把上游停掉：上游还在算就是在计费，账号还占着。
  //
  // 非流式那条路尤其要紧：答复要等整个上游的流读完才发出去，客户端在这
  // 中间走了（超时、按了取消），没人停上游的话它就接着算到超时（2026-11-03，
  // 作者复查发现）。
  const watch = watchClientGone(out);
  let response: Response;
  try {
    const upstream = await underPolicy(
      route.platform,
      "workbuddy",
      (account) =>
        workbuddyChat(openaiBody, {
          providerId: account.id,
          stream,
          conversationId,
          model: ctx.workbuddyModel(model),
          signal: watch.signal,
        }).catch((e) => {
          // 客户端走了不是上游的错：策略看到的是这个，它才不会给账号记冷却。
          throw asClientGone(e, watch);
        }),
      settle,
      ctx.availability,
    );
    response = upstream.response;
  } catch (e) {
    // 客户端走了不是上游的错：不能因此给账号记冷却，也不能换账号再打一次。
    // 先翻译再停：`watch.gone()` 靠那个信号判，信号要先在才能判准。
    const failure = asClientGone(e, watch);
    watch.stop();
    throw failure;
  }
  if (!stream) {
    // The upstream always answers with a stream, so a non-streaming request is
    // folded back into one object here.
    let json: any;
    try {
      // 盯着客户端：它在这中间走了就把上游的流掐掉（上游还在算就是在计费）。
      json = await aggregateStream(response, model, watch.signal);
    } catch (e) {
      // 客户端走了不是上游的错：账号不该记冷却，这个请求也不该再打一次。
      const failure = asClientGone(e, watch);
      settle.failure(failure);
      if (failure instanceof ClientGoneError) throw failure;
      // 流读到一半断了：那是上游的失败，账号要记冷却。
      throw new AuthError(
        `upstream stream failed (${(e as Error)?.message ?? "unknown"})`,
        "WorkBuddy 的响应流中断了。",
        502,
      );
    } finally {
      watch.stop();
    }
    deliverJson(out, dialect, "openai", json, route.label ?? model, ctx.onUsage);
    settle.success();
    return;
  }
  // 流式那条路：答复是边读边发的，客户端走了由答复那一层管（见
  // lib/router/deliver.ts 的 replyState）。这里的 watch 在上游回第一帧之前就
  // 停了 —— 流式那条路的客户端走了，靠的是答复那一层自己的监听器与看门狗。
  watch.stop();

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
