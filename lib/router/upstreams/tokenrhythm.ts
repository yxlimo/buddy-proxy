// lib/router/upstreams/tokenrhythm.ts — the relay station.
//
// It is the one upstream whose policy can be expiry_first, so it does not
// go through underPolicy: its order comes from the wallet, and the busy
// case is retried on the same account instead of moving on.

import type Koa from "koa";
import { AuthError } from "../../credential.ts";
import { anthropicToOpenAI } from "../../dialect/request.ts";
import {
  markAccountOutOfMoney,
  orderedAccounts,
  resetTokenRhythmStatusCache,
  tokenRhythmStatuses,
  usableAccounts,
  type TokenRhythmAccountStatus,
} from "../../tokenrhythm/wallet.ts";
import {
  pinnedBalanceAccount,
  setBalanceAccount,
} from "../../tokenrhythm/balance.ts";
import { kindOf } from "../../provider-kinds.ts";
import { tokenRhythmChat, TokenRhythmBusyError } from "../../tokenrhythm/transport.ts";
import { deliverJson, deliverOpenAIStream, type Dialect } from "../deliver.ts";
import { byOrder, describeUpstreamError, isDegradableUpstreamError, isNoBalanceFailure, selectProvider, type ProviderPolicy } from "../provider-selection.ts";
import { provider } from "../../providers.ts";
import { platformOf, platformPolicy } from "../../platforms.ts";
import { upstreamModel, type Route } from "../routes.ts";
import { retryAfterMs } from "../../upstream-status.ts";
import { type UpstreamContext, upstreamStatusError, accountFailure } from "./policy.ts";

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
        // retry-after 是上游说的「过多久再来」：挂到错误上，冷却照它算。
        throw upstreamStatusError(response.status, text, "TokenRhythm ", retryAfterMs(response) ?? undefined);
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
