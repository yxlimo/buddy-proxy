// lib/kinds/zcode.ts — ZCode.
//
// The plan is a bucket of tokens, and the endpoint speaks the Anthropic dialect
// (lib/zcode/transport.ts).

import { zcodeCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  registerKind,
  sessionOnlyPlan,
  type HealthSnapshot,
  type ProviderRow,
  type QuotaView,
} from "./shared.ts";
import { zcodeStatus } from "../zcode/auth.ts";
import { zcodeModelsInUse } from "../zcode/models.ts";
import { ZCODE_MESSAGES_URL } from "../zcode/transport.ts";

/**
 * The plan buckets the snapshot holds for this account, or `null` when nothing
 * was learned.
 *
 * Three shapes have to stay apart, because two of them look the same once the
 * buckets are read out as a list:
 *
 *   no entry, or `quota: null`   the platform was not asked, or the call
 *                                failed — we know nothing
 *   `quota.buckets: []`          asked, answered 200, and the platform listed
 *                                no bucket at all — the plan is spent or has
 *                                expired. This is ZCode's way of saying "used
 *                                up", not its default for "no quota".
 *   `quota.buckets: [bucket]`    the plan as the platform reports it
 *
 * Collapsing the middle shape into the first is what made a spent account look
 * ready: the panel showed no quota card and the state stayed `ready`, while the
 * next request came back with business code 1005 (a 402 on our side).
 */
function zcodeBucketsOf(provider: ProviderRow, snapshot: HealthSnapshot): any[] | null {
  const quota = (snapshot.zcode?.[provider.id]?.quota ?? null) as any;
  if (!quota) return null;
  return Array.isArray(quota.buckets) ? quota.buckets : null;
}

function zcodeQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const buckets = zcodeBucketsOf(provider, snapshot);
  if (buckets === null) return [];
  const view = (credits: QuotaView["credits"]): QuotaView[] => [
    { upstreamId: provider.platform, accountId: provider.id, credits },
  ];
  // An empty list is the answer "spent", so the panel gets a card that says so
  // instead of no card at all. Showing nothing would read as "no quota here".
  if (!buckets.length) {
    return view({
      total: 0,
      used: 0,
      remaining: 0,
      lots: [],
      note: "套餐额度已用完（平台没有返回额度桶）",
    });
  }
  return view({
    // Start Plan 的额度是 token 桶：它是一份「还剩多少 token」的额度。
    total: buckets.reduce((sum, b) => sum + Number(b.total ?? 0), 0),
    used: buckets.reduce((sum, b) => sum + Number(b.used ?? 0), 0),
    remaining: buckets.reduce((sum, b) => sum + Number(b.remaining ?? 0), 0),
    lots: buckets.map((b, i) => ({
      id: `zcode-bucket-${i}`,
      sourceLabel: b.showName || "额度桶",
      remaining: Number(b.remaining ?? 0),
      expiresAt: b.expiresAt ? Date.parse(String(b.expiresAt)) : 0,
      status: "有效",
    })),
    note: "Start Plan 的额度桶",
  });
}

registerKind({
  kind: "zcode",
  label: "ZCode",
  login: "browser",
  policies: ["single", "fallback"],
  baseUrl: () => ZCODE_MESSAGES_URL.replace(/\/anthropic\/v1\/messages$/, ""),
  // 推理用的就是凭据文件里那份 JWT：会话本身就是推理凭据。
  inferWith: "session",
  // 凭据只有登录会话（JWT 没有刷新通道，过期了只能重登）。
  credentials: sessionOnlyPlan({ title: "ZCode 的凭据" }),
  credential: (provider) => fromUpstreamStatus(zcodeStatus(provider.id), "session"),
  models: () => zcodeCatalogModels(zcodeModelsInUse()),
  quotas: (provider, snapshot) => zcodeQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    const buckets = zcodeBucketsOf(provider, snapshot);
    // Never asked, or the call failed: not knowing is not "spent".
    if (buckets === null) return false;
    // Asked and not a single bucket: spent (see zcodeBucketsOf).
    if (!buckets.length) return true;
    return buckets.every((b: any) => Number(b.remaining ?? 0) <= 0);
  },
  recoverAt: (provider, snapshot) => {
    // 额度桶的到期时间：最早到期的那个先回来。桶空了就是不知道 —— 没有桶
    // 就没有到期时间，不编一个。
    const buckets = zcodeBucketsOf(provider, snapshot) ?? [];
    const now = Date.now();
    let soonest: number | null = null;
    for (const bucket of buckets) {
      for (const key of ["expiresAt", "periodEnd"]) {
        if (!bucket?.[key]) continue;
        const at = Date.parse(String(bucket[key]));
        if (!Number.isFinite(at) || at <= now) continue;
        if (soonest === null || at < soonest) soonest = at;
      }
    }
    return soonest;
  },
});
