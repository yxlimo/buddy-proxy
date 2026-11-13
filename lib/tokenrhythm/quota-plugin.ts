// lib/tokenrhythm/quota-plugin.ts — 中转站的钱包做成一个额度插件。
//
// 一个账号一个钱包：钱只能拿会话 cookie 读（推理用的那把 key 读不到它）。所以
// 这个插件做一件事：问一次这个账号的钱包，把答复或异常翻成一个结论。
//
// 钱包里的钱是会过期的那种：赠金按批次到期，先到期的先花，本金花在最后。所以
// 「见底之后什么时候回来」不是一个时刻，而是下一批到期的时候 —— 那时候平台会
// 把这批钱收走，但余额并不会因为到期变多。把它报出来，是因为面板要能回答「这条
// 账号什么时候会彻底不能用了」。
//
// 这个插件不要任何额外的凭据段（fields 是空的）：查额度用的就是登录换来的会话，
// 用户不必再填第二个东西。账号密码不在 —— 那是「还没填」，翻成 missing。

import type { BalanceLotView, QuotaView } from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { quotaProbe } from "../quota-state.ts";
import { registerQuotaPlugin, type QuotaProbe } from "../quota-plugin-registry.ts";
import { tokenRhythmStatuses, type TokenRhythmAccountStatus } from "./wallet.ts";
// 插件 id 住在一个没有依赖的地方（lib/tokenrhythm/quota-plugin-id.ts）：本模块与
// register 互相引用，id 若在本模块里，register 在求值期读它就会撞上「还在初始化」。
import { TOKENRHYTHM_WALLET_PLUGIN_ID } from "./quota-plugin-id.ts";
export { TOKENRHYTHM_WALLET_PLUGIN_ID };

/** 平台标记「永不过期」的那一天。 */
const PERMANENT_AT = Date.parse("2099-12-31T00:00:00Z");

/**
 * 钱包报成余额。
 *
 * 从 lib/kinds/tokenrhythm.ts 原样搬过来，一个数字都没动：迁移不许改口径。一个
 * 账号一行一个钱包，`accountId` 是这一行账号 —— 面板靠它分清是哪一条余额。
 */
export function tokenRhythmWalletViews(provider: ProviderRow, status: TokenRhythmAccountStatus): QuotaView[] {
  const wallet = status.wallet;
  if (!wallet) return [];
  const lots: BalanceLotView[] = (status.credits?.list ?? []).map((lot) => ({
    id: lot.id,
    sourceLabel: lot.sourceLabel || lot.source,
    remainingCny: Number(lot.remainingCny ?? 0),
    expiresAt: lot.expiresAt ? Date.parse(String(lot.expiresAt)) : 0,
    status: lot.status || "",
  }));
  const nextExpiryAt = status.credits?.summary?.nextExpiryAt
    ? Date.parse(String(status.credits.summary.nextExpiryAt))
    : 0;
  // 平台用 2099-12-31 标记「永不过期」，那一批不算会过期。
  const expiringCny = lots
    .filter((lot) => lot.expiresAt > 0 && lot.expiresAt < PERMANENT_AT)
    .reduce((sum, lot) => sum + lot.remainingCny, 0);
  return [
    {
      upstreamId: provider.platform,
      accountId: provider.id,
      balance: {
        availableCny: Number(wallet.availableCny ?? 0),
        currency: wallet.currency || "CNY",
        lots,
        nextExpiryAt: Number.isFinite(nextExpiryAt) ? nextExpiryAt : 0,
        expiringCny,
      },
    },
  ];
}

/**
 * 见底之后什么时候回来。
 *
 * 先到期的那一批先走：还有钱的那批先算，空了的那批到期也变不出钱来。都与
 * lib/kinds/tokenrhythm.ts 的那一份逐字相同。
 */
export function tokenRhythmRecoverAt(status: TokenRhythmAccountStatus | null): number | null {
  if (!status?.wallet) return null;
  const now = Date.now();
  const lots = status.credits?.list ?? [];
  const live = lots.filter((lot) => Number(lot.remainingCny ?? 0) > 0);
  const candidates = (live.length ? live : lots)
    .map((lot) => (lot.expiresAt ? Date.parse(String(lot.expiresAt)) : 0))
    .filter((at) => at > now);
  if (candidates.length) return Math.min(...candidates);
  const next = status.credits?.summary?.nextExpiryAt
    ? Date.parse(String(status.credits.summary.nextExpiryAt))
    : 0;
  return next > now ? next : null;
}

export const tokenRhythmWalletPlugin = registerQuotaPlugin({
  id: TOKENRHYTHM_WALLET_PLUGIN_ID,
  label: "TokenRhythm 钱包",
  fields: [],
  probe: async (account) => {
    let statuses: TokenRhythmAccountStatus[];
    try {
      // 读的是缓存的视图（几分钟内复用），面板与路由看到的是同一份数；缓存过期
      // 它自己会去问平台。
      statuses = await tokenRhythmStatuses(account.id);
    } catch (e) {
      return quotaProbe("unknown", `查询钱包时抛出异常：${describeThrow(e)}`);
    }
    const mine = statuses.find((status) => status.accountId === account.id) ?? null;
    // 账号不在表里说明问错了地方（这是代码的问题，不是平台说的）：不知道。
    if (!mine) return quotaProbe("unknown", "这个账号不在 TokenRhythm 的账号表中，无法查询钱包");
    if (!mine.wallet) return stateOfFailure(mine);

    const available = Number(mine.wallet.availableCny ?? 0);
    const currency = mine.wallet.currency || "CNY";
    // 余额读到了、而且是空的：这才叫没钱。读不到是另一回事（上面那个分支）。
    if (available <= 0) {
      return quotaProbe("no_quota", `钱包已见底：剩余 ${available} ${currency}`, {
        recoverAt: tokenRhythmRecoverAt(mine),
      });
    }
    return quotaProbe("ok", `钱包剩余 ${available} ${currency}`, {
      views: tokenRhythmWalletViews(account, mine),
    });
  },
});

/**
 * 没读到钱包时，翻成哪一种状态。
 *
 * 四种原因是四件事：凭据还没填（用户去填）、被拒（重新登录）、被限流（等一会儿）、
 * 问不到（不知道）。混成一句话，面板就只能一律说「不知道」。
 */
function stateOfFailure(status: TokenRhythmAccountStatus): QuotaProbe {
  const message = status.error ?? "平台没有返回结果";
  switch (status.errorKind) {
    case "missing":
      return quotaProbe("missing", "账号上没有账号密码，无法查询钱包");
    case "unauthorized":
      return quotaProbe("unauthorized", message);
    case "rate_limited":
      return quotaProbe("rate_limited", message, {
        recoverAt: status.errorRetryAfterMs == null ? null : Date.now() + status.errorRetryAfterMs,
      });
    default:
      return quotaProbe("unknown", `未能查询钱包：${message}`);
  }
}

/** 一句人类能读的「抛了什么」。 */
function describeThrow(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return `等平台超时（${error.message}）`;
    if (error.name === "TypeError") return `连不上平台（${error.message}）`;
    return `${error.name}：${error.message}`;
  }
  return String(error);
}
