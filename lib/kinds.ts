// lib/kinds.ts — the kinds, one entry each.
//
// This is where "what does a MiniMax Code gateway look like" lives. The
// registry (lib/provider-kinds.ts) holds the shape; this file fills it in.
//
// A kind is not an account: two accounts of the MiniMax open platform are two
// providers of the same kind, under one upstream. Everything here takes the
// upstream, so the answer can depend on which one is asking.

import {
  fromUpstreamStatus,
  registerKind,
  type BalanceLotView,
  type TokenPlanView,
  type CreditLotView,
  type CredentialView,
  type HealthSnapshot,
  type QuotaView,
} from "./provider-kinds.ts";
import type { TokenRhythmAccountStatus } from "./tokenrhythm/wallet.ts";
import type { ProviderRow } from "./providers.ts";
import { CredentialState } from "./gen/buddy/admin/v1/admin_pb.ts";
import { tokenFingerprint } from "./credential.ts";
import { isIgnoredPlanWindow } from "./cooldown.ts";
import {
  minimaxCatalogModels,
  miniMaxApiCatalogModels,
  qoderCatalogModels,
  tokenRhythmCatalogModels,
  workbuddyCatalogModels,
  zcodeCatalogModels,
} from "./catalog-models.ts";

/* ------------------------------------------------------------------ *
 * The open platforms that are a declaration (lib/router/compatible-platform.ts)
 * ------------------------------------------------------------------ */

// 这两个种类在自己的模块里登记：接一个开放平台是写一段声明，不是在这里
// 再加一个 registerKind 块。放在这里 import 是为了让登记在 kindOf() 之前发生。
import "./sensenova/register.ts";
import "./intern-ai/register.ts";

/* ------------------------------------------------------------------ *
 * The MiniMax Code gateway
 * ------------------------------------------------------------------ */

import { credentialStatus as minimaxCredentialStatus } from "./minimax/auth.ts";
import { refreshSession as refreshMiniMaxSession } from "./minimax/oauth.ts";
import { runMiniMaxBenefits } from "./minimax/checkin.ts";
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
import { refreshSession as refreshQoderSession } from "./qoder/auth.ts";
import { qoderModelsForRegion } from "./qoder/models.ts";
import { ENDPOINTS as QODER_ENDPOINTS } from "./qoder/auth.ts";
import { runQoderBenefits } from "./qoder/benefits.ts";

/* ------------------------------------------------------------------ *
 * WorkBuddy
 * ------------------------------------------------------------------ */

import { workbuddyStatus } from "./workbuddy/auth.ts";
import { refreshSession as refreshWorkBuddySession } from "./workbuddy/auth.ts";
import { runWorkBuddyBenefits } from "./workbuddy/benefits.ts";
import { isRequestMissingBalance, setBalanceAccount } from "./tokenrhythm/balance.ts";

import { ENDPOINTS as WORKBUDDY_ENDPOINTS } from "./workbuddy/auth.ts";

/* ------------------------------------------------------------------ *
 * TokenRhythm
 * ------------------------------------------------------------------ */

import { TOKENRHYTHM_API_BASE } from "./tokenrhythm/accounts.ts";
import { tokenRhythmStatus } from "./tokenrhythm/wallet.ts";

/* ------------------------------------------------------------------ *
 * SenseNova
 * ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ *
 * 书生·端砚
 * ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ *
 * ZCode
 * ------------------------------------------------------------------ */

import { workbuddyModelList } from "./workbuddy/models.ts";
import { zcodeStatus } from "./zcode/auth.ts";
import { zcodeModelsInUse } from "./zcode/models.ts";
import { ZCODE_MESSAGES_URL } from "./zcode/transport.ts";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

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
  const all = Array.isArray(raw?.windows) ? raw.windows : [];
  const windows = all.filter((w: any) => !isIgnoredPlanWindow(w));
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
  policies: ["single", "fallback"],
  baseUrl: () => MINIMAX_UPSTREAM.replace(/\/messages$/, ""),
  credential: (provider) => {
    const raw = minimaxCredentialStatus(provider.id);
    const view = fromUpstreamStatus(raw, "session");
    if (raw.mode === "file") view.detail = view.detail || "读的是桌面端的 store，刷新由桌面端负责";
    return view;
  },
  models: () => minimaxCatalogModels(MINIMAX_MODELS),
  quotas: (provider, snapshot) => minimaxQuotas(provider, snapshot),
  benefits: (provider) => runMiniMaxBenefits(provider.id),
  // 客户端自己按时间表换令牌，网关也这样（见 lib/periodic.ts）。
  refresh: async (provider) => {
    await refreshMiniMaxSession(provider.id);
  },
  outOfCredits: (provider, snapshot) => {
    // 账户余额不是那道闸：这个网关用的是 coding plan，余额是 0 也能跑。看 plan 的窗口。
    const mine = (snapshot.minimax?.[provider.id] ?? {}) as any;
    // 快照里存的是平台原样的窗口，视频窗口（video）也在里面 —— 排掉。
    const windows = ((mine.tokenPlan?.windows ?? []) as any[]).filter((w) => !isIgnoredPlanWindow(w));
    if (!windows.length) return false;
    // 视频窗口（video）已经被 IGNORED_PLAN_WINDOWS 排掉了（网关只服务文本
    // 模型），剩下的窗口都是文本的：任一文本窗口见底，这个账号就没钱了。
    return windows.every(
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
  // 一把 key 一个租户：租户之间可以换着来。
  policies: ["single", "fallback"],
  baseUrl: () => miniMaxApiBase(),
  credential: (provider) => {
    const tenants = miniMaxApiTenants(provider.id);
    return apiKeyCredential(
      tenants.map((t) => t.key),
      tenants.length === 1 ? "1 个租户" : `${tenants.length} 个租户`,
    );
  },
  models: (provider) =>
    // 开放平台一把 key 一个租户：没有 key 就没有模型可公布。
    miniMaxApiTenants(provider.id).length ? miniMaxApiCatalogModels(MINIMAX_API_MODELS) : [],
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

registerKind({
  kind: "workbuddy",
  label: "WorkBuddy",
  login: "browser",
  policies: ["single", "fallback"],
  baseUrl: () => WORKBUDDY_ENDPOINTS.cn.base,
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
});
