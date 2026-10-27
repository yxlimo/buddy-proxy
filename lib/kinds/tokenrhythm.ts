// lib/kinds/tokenrhythm.ts — TokenRhythm, the relay.
//
// One account is one wallet, and the credit expires, so this is the only kind
// that can pick by expiry (expiry_first): the periodic scan pins the account
// whose credit expires first.

import { tokenRhythmCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  registerKind,
  type BalanceLotView,
  type HealthSnapshot,
  type ProviderRow,
  type QuotaView,
} from "./shared.ts";
import type { TokenRhythmAccountStatus } from "../tokenrhythm/wallet.ts";
import { TOKENRHYTHM_API_BASE } from "../tokenrhythm/accounts.ts";
import { tokenRhythmStatus } from "../tokenrhythm/wallet.ts";
import { isRequestMissingBalance, setBalanceAccount } from "../tokenrhythm/balance.ts";

function tokenrhythmQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  // 快照里一个平台一段，装着这个平台每个账号的钱包；这一行账号取自己那一个。
  const all = ((snapshot.tokenrhythm?.[provider.id]?.tenants ?? []) as unknown) as TokenRhythmAccountStatus[];
  const mine = all.filter((status) => status.accountId === provider.id);
  const status = mine[0] ?? null;
  const wallet = status?.wallet ?? null;
  if (!wallet) return [];
  const lots: BalanceLotView[] = (status?.credits?.list ?? []).map((lot) => ({
    id: lot.id,
    sourceLabel: lot.sourceLabel || lot.source,
    remainingCny: Number(lot.remainingCny ?? 0),
    expiresAt: lot.expiresAt ? Date.parse(String(lot.expiresAt)) : 0,
    status: lot.status || "",
  }));
  const nextExpiryAt = status?.credits?.summary?.nextExpiryAt
    ? Date.parse(String(status.credits.summary.nextExpiryAt))
    : 0;
  // 平台用 2099-12-31 标记「永不过期」，那一批不算会过期。
  const expiringCny = lots
    .filter((lot) => lot.expiresAt > 0 && lot.expiresAt < PERMANENT_AT)
    .reduce((sum, lot) => sum + lot.remainingCny, 0);
  return [
    {
      upstreamId: provider.platform,
      // 一个账号一行一个钱包：面板靠这个分清是哪一条余额。
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

/** 平台标记「永不过期」的那一天。 */
const PERMANENT_AT = Date.parse("2099-12-31T00:00:00Z");

registerKind({
  kind: "tokenrhythm",
  // 开放 API 平台：请求直接转发，会话相关的头也跟着过去。
  openPlatform: true,
  label: "TokenRhythm",
  login: "password",
  // 一个账号一个钱包。赠金会过期，所以它还能按到期先后挑。
  policies: ["single", "fallback", "expiry_first"],
  baseUrl: () => TOKENRHYTHM_API_BASE,
  credential: (provider) => fromUpstreamStatus(tokenRhythmStatus(provider.id), "session"),
  models: () => tokenRhythmCatalogModels(),
  quotas: (provider, snapshot) => tokenrhythmQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    // A tenant whose wallet could not be read is "unknown", not "no money".
    const mine = (snapshot.tokenrhythm?.[provider.id] ?? {}) as any;
    const tenants = ((mine.tenants ?? []) as any[]).filter((t: any) => t?.wallet);
    if (!tenants.length) return false;
    return tenants.every((t: any) => Number(t.wallet?.availableCny ?? 0) <= 0);
  },
  // 定时扫描余额，把「现在该用哪个账户」钉下来（赠金最先到期的那个）。
  // 钉住的单位是平台：一副账号里哪个先用是平台的事。
  scan: async (provider) => {
    await setBalanceAccount(provider.platform);
  },
  // The hook of expiry_first: the platform says this account has no money left.
  isRequestMissingBalance: (error) => isRequestMissingBalance(error),
});
