// lib/router/upstreams/minimax.ts — the MiniMax Code upstream.
//
// MiniMax Code speaks the Anthropic dialect natively.

import type Koa from "koa";
import { AuthError } from "../../credential.ts";
import { openaiToAnthropic } from "../../dialect/request.ts";
import { MINIMAX_MODELS } from "../../minimax/models.ts";
import { gatewayErrorMessage, minimaxChat, PING_MS } from "../../minimax/transport.ts";
import { deliverAnthropicStream, deliverJson, type Dialect } from "../deliver.ts";
import { withBusinessCode, withCooldownUntil, withUpstreamStatus, retryAfterMs } from "../../upstream-status.ts";
import { upstreamModel, type Route } from "../routes.ts";
import { type UpstreamContext, keepUpstreamTruth, settlement, underPolicy } from "./policy.ts";

/** The output limit of a MiniMax model, as its own catalog says. */
function minimaxMaxOutput(model: string): number {
  // The catalog is the only place a limit comes from. A made-up number here
  // would be a limit the gateway never agreed to.
  const found = MINIMAX_MODELS.find((m) => m.id === model);
  if (!found) throw new AuthError("unknown minimax model", `没有这个 MiniMax 模型：${model}`, 400);
  return found.output;
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

  // 生效上限：客户端给了就用它的，没给才是目录默认值。日志拿它算用掉多少。
  if (typeof (anthropicBody as any).max_tokens === "number") {
    ctx.upstreamMaxTokens = (anthropicBody as any).max_tokens;
  }

  let r: Response;
  // 流式答复是在这里返回之后才消费的：冷却由调用方在流结束时结算，
  // 「响应头到了」不算成功。
  const settle = settlement();
  try {
    r = await underPolicy(
      route.platform,
      "minimax",
      async (account) => {
        const res = await minimaxChat(anthropicBody, account.id);
        if (res.ok) return res;
        // 平台的拒绝必须在策略里抛出来：策略只看得见异常，看不见 Response。
        // 早先这里把 !ok 的判断放在 underPolicy 外面，429/402 就永远落不到
        // 降级上 —— 账号被限了也不知道换下一个。
        throw await minimaxRejection(res);
      },
      settle,
    );
  } catch (e) {
    // 换掉错误对象会把上游自己的状态与业务码丢掉，日志与分类器就看不出
    // 真实发生了什么。
    const err = e as AuthError;
    throw keepUpstreamTruth(new AuthError(err.message, err.hint, err.status, err.type), e);
  }

  if (!stream) {
    const json = await r.json();
    deliverJson(out, dialect, "anthropic", json, route.label ?? upstreamModel(route), ctx.onUsage);
    settle.success();
    return;
  }

  try {
    await deliverAnthropicStream(
      out,
      r.body!,
      dialect,
      route.label ?? upstreamModel(route),
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
 * 平台拒了这次请求：把它变成带上游状态的异常。
 *
 * 必须抛，不能返回 Response——策略（underPolicy）只看得见异常。
 * 返回一个 429 给它，等于什么都没说，账号也就不会换。
 */
async function minimaxRejection(res: Response): Promise<AuthError> {
  const text = await res.text().catch(() => "");
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const { type, message } = gatewayErrorMessage(res.status, parsed, text);
  const error = new AuthError(message, "", res.status, type);
  withUpstreamStatus(error, res.status);
  // 上游说的「过多久再试」：冷却到那时候为止（路由层看这个，不自己猜）。
  const wait = retryAfterMs(res);
  if (wait !== null) withCooldownUntil(error, Date.now() + wait);
  // 业务码：先在信封里找，再找正文末尾括号里的那个。MiniMax Code 报
  // Token Plan 用完时是 `当前已达到 Token Plan 用量上限…… (2067)`，码在
  // 正文里，不在字段上。
  const code = parsed?.base_resp?.status_code ?? trailingCode(message);
  if (typeof code === "number" && Number.isFinite(code)) withBusinessCode(error, code);
  return error;
}

/** 正文末尾括号里的业务码：`…… 用量上限。(2067)`。 */
function trailingCode(text: string): number | null {
  const found = /\((\d{3,6})\)\s*$/.exec(String(text ?? "").trim());
  return found ? Number(found[1]) : null;
}
