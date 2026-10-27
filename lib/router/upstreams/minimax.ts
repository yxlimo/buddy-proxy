// lib/router/upstreams/minimax.ts — MiniMax Code and the MiniMax open platform.
//
// MiniMax Code speaks the Anthropic dialect natively; the open platform
// speaks the OpenAI one. They are two upstreams with two kinds of
// credential, so they have two adapters.

import type Koa from "koa";
import { AuthError } from "../../credential.ts";
import { anthropicToOpenAI, openaiToAnthropic } from "../../dialect/request.ts";
import { MINIMAX_MODELS } from "../../minimax/models.ts";
import {
  miniMaxApiBusinessCode,
  miniMaxApiChat,
  miniMaxApiTenants,
  peekMiniMaxApiStream,
  MiniMaxApiBusinessError,
} from "../../minimax/api.ts";
import { gatewayErrorMessage, minimaxChat, PING_MS } from "../../minimax/transport.ts";
import { deliverAnthropicStream, deliverJson, deliverOpenAIStream, type Dialect } from "../deliver.ts";
import { byOrder, describeUpstreamError, isDegradableUpstreamError, selectProvider } from "../provider-selection.ts";
import { withBusinessCode, withCooldownUntil, withUpstreamStatus, retryAfterMs } from "../../upstream-status.ts";
import { accountsOfPlatform } from "../../providers.ts";
import { platformPolicy } from "../../platforms.ts";
import { platformWithoutAccount, upstreamModel, type Route } from "../routes.ts";
import { type UpstreamContext, accountFailure, keepUpstreamTruth, settlement, underPolicy } from "./policy.ts";

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

/**
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
