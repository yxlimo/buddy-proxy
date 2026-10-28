// lib/kinds/zcode.ts — ZCode.
//
// The plan is a bucket of tokens, and the endpoint speaks the Anthropic dialect
// (lib/zcode/transport.ts).

import { zcodeCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  registerKind,
  type HealthSnapshot,
  type ProviderRow,
  type QuotaView,
} from "./shared.ts";
import { zcodeStatus } from "../zcode/auth.ts";
import { zcodeModelsInUse } from "../zcode/models.ts";
import { ZCODE_MESSAGES_URL } from "../zcode/transport.ts";

function zcodeQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const quota = (snapshot.zcode?.[provider.id]?.quota ?? null) as any;
  const buckets = (quota?.buckets ?? []) as any[];
  if (!buckets.length) return [];
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      // Start Plan 的额度是 token 桶：它是一份「还剩多少 token」的额度。
      credits: {
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
      },
    },
  ];
}

registerKind({
  kind: "zcode",
  label: "ZCode",
  login: "browser",
  policies: ["single", "fallback"],
  baseUrl: () => ZCODE_MESSAGES_URL.replace(/\/anthropic\/v1\/messages$/, ""),
  credential: (provider) => fromUpstreamStatus(zcodeStatus(provider.id), "session"),
  models: () => zcodeCatalogModels(zcodeModelsInUse()),
  quotas: (provider, snapshot) => zcodeQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    const mine = (snapshot.zcode?.[provider.id] ?? {}) as any;
    const buckets = ((mine.quota ?? {}).buckets ?? []) as any[];
    if (!buckets.length) return false;
    return buckets.every((b: any) => Number(b.remaining ?? 0) <= 0);
  },
  recoverAt: (provider, snapshot) => {
    // 额度桶的到期时间：最早到期的那个先回来。
    const mine = (snapshot.zcode?.[provider.id] ?? {}) as any;
    const buckets = ((mine.quota ?? {}).buckets ?? []) as any[];
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
