// lib/intern-ai/register.ts — what 书生·端砚 (Discovery) is, as a declaration.
//
// The transport is shared with every other open platform (lib/router/openai-platform.ts);
// what is left of this one is its address, its key and its 墨点 balance.

import { internAiCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  type CreditLotView,
  type HealthSnapshot,
  type QuotaView,
} from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { internAiStatus } from "./auth.ts";
import { INTERN_AI_DISCOVERY_API_BASE } from "./config.ts";
import type { InternAiBalance, InternAiCreditPack } from "./quota.ts";
import { internAiCatalog, internAiInferenceKey } from "./transport.ts";

function internAiQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const balance = snapshot.internAi?.[provider.id]?.balance as InternAiBalance | null;
  if (!balance) return [];
  const packs = (snapshot.internAi?.[provider.id]?.packs as InternAiCreditPack[] | null) ?? [];
  // 只有还在的批次算数：过期与作废的不算。
  const alive = packs.filter((pack) => pack.status === "available" || pack.status === "unused");
  const lots: CreditLotView[] = alive.map((pack) => ({
    id: pack.id,
    sourceLabel: pack.remark || pack.cycleType || pack.id,
    remaining: pack.remainingCredits,
    expiresAt: platformTimeMs(pack.expireAt) || platformTimeMs(pack.cycleEndAt),
    // 一批墨点用完了就是用完了，不管平台还把它算不算「还在」。
    status:
      pack.remainingCredits > 0
        ? pack.status === "unused"
          ? "未使用"
          : "可用"
        : "已用尽",
  }));
  const total = alive.reduce((sum, pack) => sum + pack.totalCredits, 0);
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      credits: {
        total,
        used: balance.used,
        remaining: balance.availableCredits,
        lots,
        note: `墨点：余额 ${balance.availableCredits}${alive.length ? `，${alive.length} 个批次` : ""}`,
      },
    },
  ];
}

/**
 * 平台给的时间戳。
 *
 * 平台按它自己的时区报（UTC+8），没带时区就按那个算。
 */
function platformTimeMs(value: string): number {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const zoned = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}+08:00`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const internAiKind = registerCompatiblePlatform({
  kind: "intern-ai",
  label: "书生·端砚",
  login: "code",
  policies: ["single", "fallback"],
  baseUrl: () => INTERN_AI_DISCOVERY_API_BASE,
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => internAiInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(internAiStatus(provider.id), "api_key"),
  models: () => internAiCatalogModels(internAiCatalog()),
  quotas: (provider, snapshot) => internAiQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    const mine = (snapshot.internAi?.[provider.id] ?? {}) as any;
    const balance = mine.balance as InternAiBalance | null;
    if (!balance) return false;
    if (balance.availableCredits <= 0) return true;
    // A window that is full is full: it cannot be spent this time round.
    for (const window of [balance.window5h, balance.window7d]) {
      if (window.enabled && window.remainingCredits <= 0) return true;
    }
    return false;
  },
});
