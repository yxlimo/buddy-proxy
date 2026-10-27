// lib/kinds/minimax.ts — the two MiniMax kinds.
//
// MiniMax Code is the closed client's gateway (a device login, an Anthropic
// endpoint). The open platform is the paid API with keys: several tenants under
// one upstream, so a key is a tenant and the tenants can be tried in turn.

import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { tokenFingerprint } from "../credential.ts";
import { minimaxCatalogModels, miniMaxApiCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  isIgnoredPlanWindow,
  registerKind,
  tokenPlanView,
  type CredentialView,
  type HealthSnapshot,
  type ProviderRow,
  type QuotaView,
  type TokenPlanView,
} from "./shared.ts";
import { credentialStatus as minimaxCredentialStatus } from "../minimax/auth.ts";
import { refreshSession as refreshMiniMaxSession } from "../minimax/oauth.ts";
import { runMiniMaxBenefits } from "../minimax/checkin.ts";
import { MINIMAX_MODELS } from "../minimax/models.ts";
import { MINIMAX_UPSTREAM } from "../minimax/transport.ts";
import { miniMaxApiTenants, MINIMAX_API_MODELS, miniMaxApiBase } from "../minimax/api.ts";

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

/** The plan of one provider, out of the snapshot. */
function minimaxTokenPlan(provider: ProviderRow, snapshot: HealthSnapshot): TokenPlanView | undefined {
  const mine = (snapshot.minimax?.[provider.id] ?? {}) as any;
  return tokenPlanView(mine.tokenPlan);
}

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
