// lib/router/upstreams/zcode.ts — ZCode.

import type Koa from "koa";
import { effortOf, openaiToAnthropic } from "../../dialect/request.ts";
import { upstreamSessionId } from "../../upstream-session.ts";
import { zcodeChat } from "../../zcode/transport.ts";
import { zcodeMaxOutput } from "../../zcode/models.ts";
import { deliverAnthropicStream, deliverJson, type Dialect } from "../deliver.ts";
import { upstreamModel, type Route } from "../routes.ts";
import { type UpstreamContext, upstreamStatusError, underPolicy } from "./policy.ts";

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
  // 上游只认小写的模型名：发 `GLM-5.3` 会被当成「不认识的请求」落到风控账上，
  // 回的是 405 + code 3012（`glm-5.3` 才是正常的 3009 并发限流那类回答）。
  // 对外公布的 id 不变，只在发上游时转小写。
  anthropicBody.model = model.toLowerCase();
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
