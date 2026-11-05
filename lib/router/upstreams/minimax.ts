// lib/router/upstreams/minimax.ts — the MiniMax Code upstream.
//
// MiniMax Code speaks the Anthropic dialect natively.

import type Koa from "koa";
import { AuthError } from "../../credential.ts";
import { openaiToAnthropic } from "../../dialect/request.ts";
import { MINIMAX_MODELS } from "../../minimax/models.ts";
import { gatewayErrorMessage, minimaxChat, PING_MS } from "../../minimax/transport.ts";
import { ClientGoneError, deliverAnthropicStream, deliverJson, type Dialect } from "../deliver.ts";
import { withBusinessCode, withCooldownUntil, withUpstreamStatus, retryAfterMs } from "../../upstream-status.ts";
import { upstreamModel, type Route } from "../routes.ts";
import { runUnderClientGone } from "./client-gone.ts";
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

  // 客户端走了就把上游停掉：上游还在算就是在计费，账号还占着。
  //
  // 非流式那条路尤其要紧：答复要等整个上游的答复读完才发出去，客户端正好在
  // 这中间走（超时、按了取消）。没人停上游的话，网关这边看到的是一个
  // AbortError —— 那个名字被算成「超时」，于是账号记一次不该记的冷却
  // （2026-11 opencode-go 那次就是这个）。
  await runUnderClientGone(out, async (guard) => {
    // 流式答复是在这里返回之后才消费的：冷却由调用方在流结束时结算，
    // 「响应头到了」不算成功。
    const settle = settlement();
    let r: Response;
    try {
      r = await underPolicy(
        route.platform,
        "minimax",
        async (account) => {
          try {
            const res = await minimaxChat(anthropicBody, account.id, guard.signal);
            if (res.ok) return res;
            // 平台的拒绝必须在策略里抛出来：策略只看得见异常，看不见 Response。
            // 早先这里把 !ok 的判断放在 underPolicy 外面，429/402 就永远落不到
            // 降级上 —— 账号被限了也不知道换下一个。
            throw await minimaxRejection(res);
          } catch (e) {
            // 客户端走了不是上游的错：策略看到的是这个，它才不会给账号记冷却、
            // 也不会换下一个账号再打一次。
            //
            // 客户端已经走了的时候，上游这一条答的是什么都不作数了（哪怕是一
            // 张 401）：那一笔账记不到账号头上，客户端连这个答复都没要。
            throw guard.fail(e) ?? (guard.gone() ? new ClientGoneError() : e);
          }
        },
        settle,
        ctx.availability,
      );
    } catch (e) {
      // 客户端走了：报出去的必须是「客户端走了」。包成 AuthError 就成了「这个
      // 账号的凭据/上游出了问题」——账记错人，还会触发降级。
      if (e instanceof ClientGoneError) throw e;
      // 换掉错误对象会把上游自己的状态与业务码丢掉，日志与分类器就看不出
      // 真实发生了什么。
      const err = e as AuthError;
      throw keepUpstreamTruth(new AuthError(err.message, err.hint, err.status, err.type), e);
    }

    if (!stream) {
      let json: any;
      try {
        json = await r.json();
      } catch (e) {
        // 客户端走了不是上游的错：账号不该记冷却，这个请求也不该再打一次。
        const gone = guard.fail(e);
        if (gone) {
          settle.failure(gone);
          throw gone;
        }
        throw e;
      }
      // 读正文的这会儿客户端走了：上游这一条答的什么都不要了，也不能拿它给
      // 账号记一笔。
      if (guard.gone()) {
        const gone = new ClientGoneError();
        settle.failure(gone);
        throw gone;
      }
      deliverJson(out, dialect, "anthropic", json, route.label ?? upstreamModel(route), ctx.onUsage);
      settle.success();
      return;
    }

    // 流式那条路：答复是边读边发的，客户端走了由答复那一层管（见
    // lib/router/deliver.ts 的 replyState）。这里的看不盯了。
    guard.done();
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
  });
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
