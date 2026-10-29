// lib/kinds/workbuddy.ts — WorkBuddy.
//
// The models are addressed by prefix only: several of them carry the same name
// as a Qoder model, so the prefix is what tells them apart.

import { workbuddyCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  registerKind,
  type HealthSnapshot,
  type ProviderRow,
  type QuotaView,
} from "./shared.ts";
import { regionFrom, workbuddyStatus } from "../workbuddy/auth.ts";
import { refreshSession as refreshWorkBuddySession } from "../workbuddy/auth.ts";
import { runWorkBuddyBenefits } from "../workbuddy/benefits.ts";
import { workbuddyModelList } from "../workbuddy/models.ts";
import { ENDPOINTS as WORKBUDDY_ENDPOINTS } from "../workbuddy/auth.ts";

function workbuddyQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const credits = snapshot.workbuddy?.[provider.id]?.credits as any;
  if (!credits) return [];
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const daily = Number(credits.daily ?? 0);
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      credits: {
        total: 0,
        used: 0,
        remaining: daily,
        lots: [
          {
            id: "workbuddy-daily",
            sourceLabel: `每日签到（连签 ${Number(credits.streakDays ?? 0)} 天）`,
            remaining: daily,
            expiresAt: endOfDay.getTime(),
            status: credits.checkedIn ? "已领取" : "未领取",
          },
        ],
        note: `每天 ${daily} 点，连签 ${Number(credits.streakDays ?? 0)} 天`,
      },
    },
  ];
}

registerKind({
  kind: "workbuddy",
  label: "WorkBuddy",
  login: "browser",
  policies: ["single", "fallback"],
  // The row carries the region, so a row that is not logged in yet still
  // answers with the right host.
  baseUrl: (provider) => WORKBUDDY_ENDPOINTS[regionFrom(provider.region)].base,
  credential: (provider) => fromUpstreamStatus(workbuddyStatus(provider.id), "session"),
  models: () => workbuddyCatalogModels(workbuddyModelList()),
  quotas: (provider, snapshot) => workbuddyQuotas(provider, snapshot),
  benefits: (provider) => runWorkBuddyBenefits(provider.id),
  // 客户端自己按时间表换令牌，网关也这样（见 lib/periodic.ts）。
  refresh: async (provider) => {
    await refreshWorkBuddySession(provider.id);
  },
  outOfCredits: (provider, snapshot) => {
    // The check-in credits: the platform reports them as "daily".
    const mine = (snapshot.workbuddy?.[provider.id] ?? {}) as any;
    const credits = mine.credits as any;
    if (!credits) return false;
    return Number(credits.daily ?? 0) <= 0;
  },
});
