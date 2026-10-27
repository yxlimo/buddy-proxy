// lib/router/upstreams/workbuddy.ts — WorkBuddy, the China region.

import type Koa from "koa";
import { AuthError } from "../../credential.ts";
import { anthropicToOpenAI } from "../../dialect/request.ts";
import { workbuddyChat, aggregateStream, conversationIdFor } from "../../workbuddy/transport.ts";
import { deliverJson, deliverOpenAIStream, type Dialect } from "../deliver.ts";
import { upstreamModel, type Route } from "../routes.ts";
import { type UpstreamContext, underPolicy } from "./policy.ts";

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
