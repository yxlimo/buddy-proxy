// lib/kinds/qoder.ts — Qoder.
//
// One row per region: global and cn are two platforms of the same kind, each
// with its own path and its own session.

import { qoderCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  registerKind,
  type CreditLotView,
  type HealthSnapshot,
  type ProviderRow,
  type QuotaView,
} from "./shared.ts";
import { qoderStatus, regionOf as qoderRegionOf } from "../qoder/auth.ts";
import { refreshSession as refreshQoderSession } from "../qoder/auth.ts";
import { qoderModelsForRegion } from "../qoder/models.ts";
import { ENDPOINTS as QODER_ENDPOINTS } from "../qoder/auth.ts";
import { runQoderBenefits } from "../qoder/benefits.ts";

function qoderQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const credits = snapshot.qoder?.[provider.id]?.credits as any;
  if (!credits) return [];
  const resetsAt = credits.resetsAt ? Date.parse(String(credits.resetsAt)) : 0;
  const planRemaining = Number(credits.plan?.remaining ?? 0);
  const lots: CreditLotView[] = [
    {
      id: `qoder-${provider.region}-plan`,
      sourceLabel: "套餐额度",
      remaining: planRemaining,
      expiresAt: resetsAt,
      // 这一池自己说了算：套餐用光了就是用光了。加油包还有多少不影响它。
      status: planRemaining > 0 ? "可用" : "已用尽",
    },
  ];
  if (Number(credits.addOn?.remaining ?? 0) > 0) {
    lots.push({
      id: `qoder-${provider.region}-addon`,
      sourceLabel: "加油包",
      remaining: Number(credits.addOn?.remaining ?? 0),
      expiresAt: 0,
      status: "可用",
    });
  }
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      credits: {
        total: Number(credits.plan?.total ?? 0) + Number(credits.addOn?.total ?? 0),
        used: Number(credits.plan?.used ?? 0) + Number(credits.addOn?.used ?? 0),
        remaining: Number(credits.plan?.remaining ?? 0) + Number(credits.addOn?.remaining ?? 0),
        lots,
        note: "平台积分",
      },
    },
  ];
}

registerKind({
  kind: "qoder",
  label: "Qoder",
  login: "device",
  needsRegion: true,
  regions: ["global", "cn"],
  // 一行就是一个账号（两个区是两行）。
  policies: ["single", "fallback"],
  baseUrl: (provider) => {
    const region = provider.region === "cn" ? "cn" : "global";
    return QODER_ENDPOINTS[region].infer.replace(/\/model\/v1\/chat\/completions$/, "");
  },
  credential: (provider) => fromUpstreamStatus(qoderStatus(provider.id), "session"),
  models: (provider) => qoderCatalogModels(qoderModelsForRegion(qoderRegionOf(provider.id))),
  quotas: (provider, snapshot) => qoderQuotas(provider, snapshot),
  benefits: (provider) => runQoderBenefits(provider.id),
  // 客户端自己按时间表换令牌，网关也这样（见 lib/periodic.ts）。
  refresh: async (provider) => {
    await refreshQoderSession(provider.id);
  },
  outOfCredits: (provider, snapshot) => {
    // The platform's own flag decides. The plan (the free part) running out
    // is not the end: the credits bought on top are a separate pool, and the
    // platform still serves the account while they are there — it says so
    // with quotaExceeded: false.
    const mine = (snapshot.qoder?.[provider.id] ?? {}) as any;
    const quota = mine.credits as any;
    if (!quota) return false;
    if (quota.quotaExceeded === true) return true;
    // No flag: fall back to both pools being empty.
    const plan = quota.plan as any;
    const addOn = quota.addOn as any;
    const planLeft = plan && Number(plan.total ?? 0) > 0 ? Number(plan.remaining ?? 0) : null;
    const addOnLeft = addOn && Number(addOn.total ?? 0) > 0 ? Number(addOn.remaining ?? 0) : null;
    if (planLeft !== null && addOnLeft !== null) return planLeft <= 0 && addOnLeft <= 0;
    return false;
  },
});
