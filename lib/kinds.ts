// lib/kinds.ts — the kinds, one entry each.
//
// This is where "what does a MiniMax Code gateway look like" lives. The
// registry (lib/provider-kinds.ts) holds the shape; this file fills it in.
//
// A kind is not an account: two accounts of the MiniMax open platform are two
// providers of the same kind, under one upstream. Everything here takes the
// upstream, so the answer can depend on which one is asking.

import {
  registerKind,
  type BalanceLotView,
  type TokenPlanView,
  type CreditLotView,
  type CredentialView,
  type HealthSnapshot,
  type QuotaView,
} from "./provider-kinds.ts";
import type { TokenRhythmTenantStatus } from "./tokenrhythm/wallet.ts";
import {
  poolEmpty,
  poolPaused,
  totalRemaining,
  type SenseNovaPoolUsage,
} from "./sensenova/quota.ts";
import type { InternAiBalance, InternAiCreditPack } from "./intern-ai/quota.ts";
import type { ProviderRow } from "./providers.ts";
import { CredentialState } from "./gen/buddy/admin/v1/admin_pb.ts";
import { tokenFingerprint } from "./credential.ts";
import {
  internAiCatalogModels,
  minimaxCatalogModels,
  miniMaxApiCatalogModels,
  qoderCatalogModels,
  senseNovaCatalogModels,
  tokenRhythmCatalogModels,
  workbuddyCatalogModels,
  zcodeCatalogModels,
} from "./catalog-models.ts";

/* ------------------------------------------------------------------ *
 * The MiniMax Code gateway
 * ------------------------------------------------------------------ */

import { credentialStatus as minimaxCredentialStatus } from "./minimax/auth.ts";
import { MINIMAX_MODELS } from "./minimax/models.ts";
import { MINIMAX_UPSTREAM } from "./minimax/transport.ts";

/* ------------------------------------------------------------------ *
 * The MiniMax open platform
 * ------------------------------------------------------------------ */

import { miniMaxApiTenants, MINIMAX_API_MODELS, miniMaxApiBase } from "./minimax/api.ts";

/* ------------------------------------------------------------------ *
 * Qoder
 * ------------------------------------------------------------------ */

import { qoderStatus, regionOf as qoderRegionOf } from "./qoder/auth.ts";
import { qoderModelsForRegion } from "./qoder/models.ts";
import { ENDPOINTS as QODER_ENDPOINTS } from "./qoder/auth.ts";

/* ------------------------------------------------------------------ *
 * WorkBuddy
 * ------------------------------------------------------------------ */

import { workbuddyStatus } from "./workbuddy/auth.ts";

import { ENDPOINTS as WORKBUDDY_ENDPOINTS } from "./workbuddy/auth.ts";

/* ------------------------------------------------------------------ *
 * TokenRhythm
 * ------------------------------------------------------------------ */

import { TOKENRHYTHM_API_BASE } from "./tokenrhythm/accounts.ts";
import { tokenRhythmStatus } from "./tokenrhythm/wallet.ts";

/* ------------------------------------------------------------------ *
 * SenseNova
 * ------------------------------------------------------------------ */

import { senseNovaStatus } from "./sensenova/auth.ts";
import { senseNovaInferenceKey } from "./sensenova/transport.ts";
import { senseNovaCatalog } from "./sensenova/transport.ts";
import { SENSENOVA_INFER_BASE } from "./sensenova/config.ts";

/* ------------------------------------------------------------------ *
 * 书生·端砚
 * ------------------------------------------------------------------ */

import { internAiStatus } from "./intern-ai/auth.ts";
import { internAiInferenceKey } from "./intern-ai/transport.ts";
import { internAiCatalog } from "./intern-ai/transport.ts";
import { INTERN_AI_DISCOVERY_API_BASE } from "./intern-ai/config.ts";

/* ------------------------------------------------------------------ *
 * ZCode
 * ------------------------------------------------------------------ */

import { workbuddyModelList } from "./workbuddy/models.ts";
import { zcodeStatus } from "./zcode/auth.ts";
import { ZCODE_MODELS } from "./zcode/models.ts";
import { ZCODE_MESSAGES_URL } from "./zcode/transport.ts";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** 把上游报的状态翻成面板要的那一套。 */
function fromUpstreamStatus(
  raw: Record<string, unknown>,
  kind: string,
  secretId: string,
): CredentialView {
  const status = String(raw.status ?? "");
  const remainingSec = Number(raw.remainingSec ?? 0);
  const expiresAt = raw.expiresAt ? Date.parse(String(raw.expiresAt)) : 0;
  const warning = raw.warning === true;
  const detail = String(raw.detail ?? "");
  return {
    kind,
    status: credentialStateOf(status),
    fingerprint: String(raw.fingerprint ?? ""),
    expiresAt,
    remainingSec,
    warning,
    detail: warning && !detail ? "凭据即将到期" : detail,
    generation: Number(raw.generation ?? 0),
  };
}

/** 上游的状态词 → 契约里的枚举。 */
function credentialStateOf(status: string): CredentialState {
  switch (status) {
    case "authenticated":
      return CredentialState.AUTHENTICATED;
    case "expired":
      return CredentialState.EXPIRED;
    case "error":
      return CredentialState.ERROR;
    case "usable":
      return CredentialState.USABLE;
    case "anonymous":
      // The upstreams that report "anonymous" mean it as "not logged in"
      // (qoder, workbuddy, minimax all do): no credential, so it is missing.
      return CredentialState.MISSING;
    case "missing":
      return CredentialState.MISSING;
    default:
      return CredentialState.MISSING;
  }
}

/** 一把 key 就是一个租户时的凭据。 */
function apiKeyCredential(keys: string[], detail: string): CredentialView {
  if (!keys.length) {
    return {
      kind: "api_key",
      status: CredentialState.MISSING,
      fingerprint: "",
      expiresAt: 0,
      remainingSec: 0,
      warning: false,
      detail: "未配置 API Key",
      generation: 0,
    };
  }
  return {
    kind: "api_key",
    status: CredentialState.AUTHENTICATED,
    fingerprint: tokenFingerprint(keys[0]),
    expiresAt: 0,
    remainingSec: 0,
    warning: false,
    detail,
    generation: 0,
  };
}

function tokenrhythmQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const tenants = ((snapshot.tokenrhythm?.[provider.id]?.tenants ?? []) as unknown) as TokenRhythmTenantStatus[];
  const out: QuotaView[] = [];
  for (const tenant of tenants) {
    const wallet = tenant.wallet;
    if (!wallet) continue;
    const lots: BalanceLotView[] = (tenant.credits?.list ?? []).map((lot) => ({
      id: lot.id,
      sourceLabel: lot.sourceLabel || lot.source,
      remainingCny: Number(lot.remainingCny ?? 0),
      expiresAt: lot.expiresAt ? Date.parse(String(lot.expiresAt)) : 0,
      status: lot.status || "",
    }));
    const nextExpiryAt = tenant.credits?.summary?.nextExpiryAt
      ? Date.parse(String(tenant.credits.summary.nextExpiryAt))
      : 0;
    // 平台用 2099-12-31 标记「永不过期」，那一批不算会过期。
    const expiringCny = lots
      .filter((lot) => lot.expiresAt > 0 && lot.expiresAt < PERMANENT_AT)
      .reduce((sum, lot) => sum + lot.remainingCny, 0);
    out.push({
      upstreamId: provider.id,
      // 一个租户一个账号：面板靠这个分清是哪一条余额。
      accountId: `${provider.id}:${tenant.index}`,
      balance: {
        availableCny: Number(wallet.availableCny ?? 0),
        currency: wallet.currency || "CNY",
        lots,
        nextExpiryAt: Number.isFinite(nextExpiryAt) ? nextExpiryAt : 0,
        expiringCny,
      },
    });
  }
  return out;
}

function senseNovaQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const usage = snapshot.sensenova?.[provider.id]?.pools as SenseNovaPoolUsage | null;
  if (!usage?.pools?.length) return [];
  // 能服务模型的池子才算数：没有模型挂在它上面的池子，扣不到。
  const pools = usage.pools.filter((pool) => pool.modelIds.length > 0);
  if (!pools.length) return [];
  const lots: CreditLotView[] = pools.map((pool) => ({
    id: pool.id,
    sourceLabel: pool.name || pool.id,
    remaining: totalRemaining(pool),
    // 活动积分有到期日；周期积分靠窗口重置，没有到期日。
    expiresAt: pool.nearestGrantExpiry ? pool.nearestGrantExpiry * 1000 : 0,
    status: poolEmpty(pool) ? "已用尽" : poolPaused(pool) ? "窗口用尽" : "可用",
  }));
  const remaining = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  const plan = usage.plan?.name ? `${usage.plan.name}：` : "";
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      credits: {
        total: 0,
        used: 0,
        remaining,
        lots,
        note: `${plan}${pools.length} 个积分池，周期积分取 5 小时与 7 天窗口里小的那个`,
      },
    },
  ];
}

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

function minimaxQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const balance = snapshot.minimax?.[provider.id]?.balance as any;
  const plan = minimaxTokenPlan(provider, snapshot);
  const lots = (snapshot.minimax?.[provider.id]?.credits ?? []) as any[];
  if (!balance && !plan && !lots.length) return [];
  // 积分：签到给的那种。账户余额（query_balance）说的是平台上的钱，Code
  // 账号上是零 —— 积分在明细里。
  const granted = lots.reduce((sum, lot) => sum + Number(lot?.granted ?? 0), 0);
  const remaining = lots.reduce((sum, lot) => sum + Number(lot?.remaining ?? 0), 0);
  const consumed = lots.reduce((sum, lot) => sum + Number(lot?.consumed ?? 0), 0);
  return [
    {
      upstreamId: provider.id,
      accountId: provider.id,
      credits: {
        total: granted,
        used: consumed,
        remaining,
        lots: lots.map((lot: any, index: number) => ({
          id: `minimax-credit-${index}`,
          sourceLabel: Number(lot?.creditType) === 2 ? "签到积分" : "账户积分",
          remaining: Number(lot?.remaining ?? 0),
          expiresAt: Number(lot?.expireAtMs ?? 0),
          status: Number(lot?.remaining ?? 0) > 0 ? "有效" : "已用完",
        })),
        note: "签到给的积分，30 天有效",
      },
      ...(plan ? { tokenPlan: plan } : {}),
    },
  ];
}

function miniMaxApiQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const tenants = (snapshot.minimaxApi?.[provider.id]?.tenants ?? []) as any[];
  return tenants.map((t: any) => ({
    upstreamId: provider.id,
    accountId: `${provider.id}:${t.index}`,
    ...(t.plan ? { tokenPlan: t.plan } : {}),
  }));
}

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

/** 平台标记「永不过期」的那一天。 */
const PERMANENT_AT = Date.parse("2099-12-31T00:00:00Z");

/**
 * MiniMax 的套餐额度。
 *
 * 平台给的是 ISO 字符串，这里换成毫秒时间戳。到期时间没有就是 0。
 */
export function tokenPlanView(plan: unknown): TokenPlanView | undefined {
  const raw = plan as any;
  const windows = Array.isArray(raw?.windows) ? raw.windows : [];
  if (!windows.length) return undefined;
  const at = (value: unknown): number => {
    if (!value) return 0;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    windows: windows.map((window: any) => ({
      label: String(window?.model ?? ""),
      intervalPercent: Math.round(Number(window?.intervalPercent ?? 0)),
      weeklyPercent: Math.round(Number(window?.weeklyPercent ?? 0)),
      intervalEndsAt: at(window?.intervalEndsAt),
      weeklyEndsAt: at(window?.weeklyEndsAt),
    })),
  };
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

/** The plan of one provider, out of the snapshot. */
function minimaxTokenPlan(provider: ProviderRow, snapshot: HealthSnapshot): TokenPlanView | undefined {
  const mine = (snapshot.minimax?.[provider.id] ?? {}) as any;
  return tokenPlanView(mine.tokenPlan);
}

/* ------------------------------------------------------------------ *
 * The registrations
 * ------------------------------------------------------------------ */

registerKind({
  kind: "minimax",
  label: "MiniMax Code",
  login: "device",
  baseUrl: () => MINIMAX_UPSTREAM.replace(/\/messages$/, ""),
  credential: (provider) => {
    const raw = minimaxCredentialStatus(provider.id);
    const view = fromUpstreamStatus(raw, "session", `session:provider:${provider.id}`);
    if (raw.mode === "file") view.detail = view.detail || "读的是桌面端的 store，刷新由桌面端负责";
    return view;
  },
  models: (provider) => minimaxCatalogModels(MINIMAX_MODELS),
  quotas: (provider, snapshot) => minimaxQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    // 账户余额不是那道闸：这个网关用的是 coding plan，余额是 0 也能跑。看 plan 的窗口。
    const mine = (snapshot.minimax?.[provider.id] ?? {}) as any;
    const windows = (mine.tokenPlan?.windows ?? []) as any[];
    if (!windows.length) return false;
    return windows.some(
      (w: any) => Number(w.intervalPercent ?? 100) <= 0 || Number(w.weeklyPercent ?? 100) <= 0,
    );
  },
});

registerKind({
  kind: "minimax-api",
  // 开放 API 平台：请求直接转发，会话相关的头也跟着过去。
  openPlatform: true,
  label: "MiniMax 开放平台",
  login: "password",
  baseUrl: () => miniMaxApiBase(),
  credential: (provider) => {
    const tenants = miniMaxApiTenants(provider.id);
    return apiKeyCredential(
      tenants.map((t) => t.key),
      tenants.length === 1 ? "1 个租户" : `${tenants.length} 个租户`,
    );
  },
  models: () => miniMaxApiCatalogModels(MINIMAX_API_MODELS),
  quotas: (provider, snapshot) => miniMaxApiQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    const mine = (snapshot.minimaxApi?.[provider.id] ?? {}) as any;
    const tenants = (mine.tenants ?? []) as any[];
    const windows = tenants.flatMap((t: any) => (t.plan?.windows ?? []) as any[]);
    if (!windows.length) return false;
    return windows.some(
      (w: any) => Number(w.intervalPercent ?? 100) <= 0 || Number(w.weeklyPercent ?? 100) <= 0,
    );
  },
});

registerKind({
  kind: "qoder",
  label: "Qoder",
  login: "device",
  needsRegion: true,
  regions: ["global", "cn"],
  baseUrl: (provider) => {
    const region = provider.region === "cn" ? "cn" : "global";
    return QODER_ENDPOINTS[region].infer.replace(/\/model\/v1\/chat\/completions$/, "");
  },
  credential: (provider) => fromUpstreamStatus(qoderStatus(provider.id), "session", `session:provider:${provider.id}`),
  models: (provider) => qoderCatalogModels(qoderModelsForRegion(qoderRegionOf(provider.id))),
  quotas: (provider, snapshot) => qoderQuotas(provider, snapshot),
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

registerKind({
  kind: "workbuddy",
  label: "WorkBuddy",
  login: "browser",
  baseUrl: () => WORKBUDDY_ENDPOINTS.cn.base,
  credential: (provider) => fromUpstreamStatus(workbuddyStatus(provider.id), "session", `session:provider:${provider.id}`),
  models: () => workbuddyCatalogModels(workbuddyModelList()),
  quotas: (provider, snapshot) => workbuddyQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    // The check-in credits: the platform reports them as "daily".
    const mine = (snapshot.workbuddy?.[provider.id] ?? {}) as any;
    const credits = mine.credits as any;
    if (!credits) return false;
    return Number(credits.daily ?? 0) <= 0;
  },
});

registerKind({
  kind: "tokenrhythm",
  // 开放 API 平台：请求直接转发，会话相关的头也跟着过去。
  openPlatform: true,
  label: "TokenRhythm",
  login: "password",
  baseUrl: () => TOKENRHYTHM_API_BASE,
  credential: (provider) => fromUpstreamStatus(tokenRhythmStatus(provider.id), "session", `session:provider:${provider.id}`),
  models: () => tokenRhythmCatalogModels(),
  quotas: (provider, snapshot) => tokenrhythmQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    // A tenant whose wallet could not be read is "unknown", not "no money".
    const mine = (snapshot.tokenrhythm?.[provider.id] ?? {}) as any;
    const tenants = ((mine.tenants ?? []) as any[]).filter((t: any) => t?.wallet);
    if (!tenants.length) return false;
    return tenants.every((t: any) => Number(t.wallet?.availableCny ?? 0) <= 0);
  },
});

registerKind({
  kind: "sensenova",
  // 开放 API 平台：请求直接转发，会话相关的头也跟着过去。
  openPlatform: true,
  label: "SenseNova",
  login: "password",
  baseUrl: () => SENSENOVA_INFER_BASE,
  credential: (provider) => fromUpstreamStatus(senseNovaStatus(provider.id), "api_key", `key:provider:${provider.id}`),
  models: () => senseNovaCatalogModels(senseNovaCatalog()),
  quotas: (provider, snapshot) => senseNovaQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    // The pools that can serve a model: the others are not spent on anything.
    const usage = snapshot.sensenova?.[provider.id]?.pools as SenseNovaPoolUsage | null;
    const pools = (usage?.pools ?? []).filter((pool) => pool.modelIds.length > 0);
    if (!pools.length) return false;
    return pools.every((pool) => totalRemaining(pool) <= 0);
  },
});

registerKind({
  kind: "intern-ai",
  // 开放 API 平台：请求直接转发，会话相关的头也跟着过去。
  openPlatform: true,
  label: "书生·端砚",
  login: "code",
  baseUrl: () => INTERN_AI_DISCOVERY_API_BASE,
  credential: (provider) => fromUpstreamStatus(internAiStatus(provider.id), "api_key", `key:provider:${provider.id}`),
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

registerKind({
  kind: "zcode",
  label: "ZCode",
  login: "browser",
  baseUrl: () => ZCODE_MESSAGES_URL.replace(/\/anthropic\/v1\/messages$/, ""),
  credential: (provider) => fromUpstreamStatus(zcodeStatus(provider.id), "session", `session:provider:${provider.id}`),
  models: () => zcodeCatalogModels(ZCODE_MODELS),
  quotas: (provider, snapshot) => zcodeQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    const mine = (snapshot.zcode?.[provider.id] ?? {}) as any;
    const buckets = ((mine.quota ?? {}).buckets ?? []) as any[];
    if (!buckets.length) return false;
    return buckets.every((b: any) => Number(b.remaining ?? 0) <= 0);
  },
});
