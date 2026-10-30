// lib/kinds/minimax.ts — the MiniMax Code kind.
//
// MiniMax Code is the closed client's gateway: a device login, an Anthropic
// endpoint, one session per account.

import { minimaxCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  isIgnoredPlanWindow,
  registerKind,
  tokenPlanView,
  type HealthSnapshot,
  type ProviderRow,
  type QuotaView,
  type TokenPlanView,
} from "./shared.ts";
import { credentialStatus as minimaxCredentialStatus } from "../minimax/auth.ts";
import { refreshSession as refreshMiniMaxSession } from "../minimax/oauth.ts";
import { runMiniMaxBenefits } from "../minimax/checkin.ts";
import { MINIMAX_MODELS } from "../minimax/models.ts";
import { isLotExpired } from "../minimax/points.ts";
import { MINIMAX_UPSTREAM } from "../minimax/transport.ts";

function minimaxQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const balance = snapshot.minimax?.[provider.id]?.balance as any;
  const plan = minimaxTokenPlan(provider, snapshot);
  // 过期的不算：路由的判定（pointsFromLedger）跳过它们，面板也得跳过 ——
  // 不然同一个账号「面板有积分、路由判没钱」，两边说的不是一回事。
  const lots = ((snapshot.minimax?.[provider.id]?.credits ?? []) as any[]).filter(
    (lot: any) => !isLotExpired(Number(lot?.expireAtMs ?? 0)),
  );
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
        note: "签到给的积分，30 天有效（只算未过期的）",
      },
      ...(plan ? { tokenPlan: plan } : {}),
    },
  ];
}

/** The plan of one provider, out of the snapshot. */
function minimaxTokenPlan(provider: ProviderRow, snapshot: HealthSnapshot): TokenPlanView | undefined {
  const mine = (snapshot.minimax?.[provider.id] ?? {}) as any;
  return tokenPlanView(mine.tokenPlan);
}

/** 平台给的时间：毫秒或者 ISO 字符串。 */
function timeMs(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 窗口里还剩百分之多少。读不到就是「还有」（100）。 */
function percentLeft(value: unknown): number {
  if (value === null || value === undefined || value === "") return 100;
  const raw = Number(String(value).replace("%", "").trim());
  return Number.isFinite(raw) ? raw : 100;
}

/**
 * 套餐窗口什么时候恢复额度。
 *
 * 与 lib/router/account-cooldown.ts 的 planWindowEndsAt 同一套取舍：先看见底的
 * 窗口（那一格结束了账号才有额度），多个见底窗口取最晚的那个 —— 少一个都不行；
 * 没有见底的窗口就退回还没到的最早到期点。
 */
function planRecovery(windows: any[], now = Date.now()): number | null {
  let exhausted: number | null = null;
  let soonest: number | null = null;
  for (const window of windows) {
    if (isIgnoredPlanWindow(window)) continue;
    for (const key of ["intervalEndsAt", "weeklyEndsAt"]) {
      const at = timeMs(window?.[key]);
      if (!at || at <= now) continue;
      if (soonest === null || at < soonest) soonest = at;
    }
    const intervalAt = timeMs(window?.intervalEndsAt);
    if (intervalAt > now && percentLeft(window?.intervalPercent) <= 0) {
      if (exhausted === null || intervalAt > exhausted) exhausted = intervalAt;
    }
    const weeklyAt = timeMs(window?.weeklyEndsAt);
    if (weeklyAt > now && percentLeft(window?.weeklyPercent) <= 0) {
      if (exhausted === null || weeklyAt > exhausted) exhausted = weeklyAt;
    }
  }
  return exhausted ?? soonest;
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
    // 模型），剩下的窗口都是文本的：任一文本窗口见底，这个账号的 plan 就没了。
    const planSpent = windows.every(
      (w: any) => Number(w.intervalPercent ?? 100) <= 0 || Number(w.weeklyPercent ?? 100) <= 0,
    );
    if (!planSpent) return false;
    // plan 见底不等于账号不能用：平台在窗口达限后还能扣积分，前提是账号里有
    // 积分，而且「Token Plan 达限后使用积分」那个开关是开的（开关关着就是
    // 2067）。所以能不能用 = plan 还有额度 或（积分 > 0 且开关开）。
    //
    // 两个数都可能是 null（读不到）。读不到是「不知道」，不是「没有」：只有
    // 明确读到积分 0、或者明确读到开关关，才允许判成没钱；不知道就退回旧行为
    // （只看 plan 窗口），不因为一次读失败就把账号判死。
    const points = mine.points?.amount;
    const fallback = mine.creditFallbackEnabled?.enabled;
    return !(typeof points === "number" && points > 0 && fallback === true);
  },
  recoverAt: (provider, snapshot) => {
    const mine = (snapshot.minimax?.[provider.id] ?? {}) as any;
    const windows = (mine.tokenPlan?.windows ?? []) as any[];
    return planRecovery(windows);
  },
});
