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
import type { WorkBuddyResources, WorkBuddySnapshotEntry } from "../workbuddy/resources.ts";

/**
 * 面板上的积分明细。
 *
 * 数字都是平台自己的账本：剩下的、已经用掉的、以及每一批积分的到期时刻。
 * 读不到账本就说读不到 —— 不拿签到积分编一条批次出来。
 */
function workbuddyQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const entry = snapshot.workbuddy?.[provider.id] as WorkBuddySnapshotEntry | undefined;
  const resources = entry?.resources;
  if (!resources) return [];
  const used = resources.groups.reduce((sum, g) => sum + Number(g.used ?? 0), 0);
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      credits: {
        total: resources.total,
        used,
        remaining: resources.total,
        lots: resources.lots.map((lot) => ({
          id: lot.id,
          sourceLabel: lot.name,
          remaining: lot.remaining,
          // 0 means the platform gave no expiry: the lot does not expire.
          expiresAt: lot.expiresAt,
          status: lot.active ? "有效" : "已失效",
        })),
        note: workbuddyNote(resources),
      },
    },
  ];
}

/**
 * 一句话的账本摘要：套餐名，加上每一组积分还剩多少。
 *
 * 全是零的组不算数（套餐赠送积分常常是 0），不然摘要里全是噪声。
 */
function workbuddyNote(resources: WorkBuddyResources): string {
  const parts: string[] = [];
  if (resources.plan) parts.push(`套餐：${resources.plan}`);
  for (const g of resources.groups) {
    if (!Number(g.total) && !Number(g.remaining) && !Number(g.used)) continue;
    parts.push(`${g.name} ${amount(g.remaining)}/${amount(g.total)}`);
  }
  return parts.join(" · ");
}

/**
 * 一个数：两位小数，但去掉后面没用的 0。
 *
 * 不取整 —— 平台给的是 double，1867.97000068 就是 1867.97000068。
 */
function amount(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Number(n.toFixed(2)));
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
    // 平台账本里的总余额。读不到就说「不知道」：不知道不算用尽。
    const entry = snapshot.workbuddy?.[provider.id] as WorkBuddySnapshotEntry | undefined;
    const resources = entry?.resources;
    if (!resources) return false;
    return Number(resources.total ?? 0) <= 0;
  },
});
