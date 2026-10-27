// lib/kinds/shared.ts — what every kind needs.
//
// The registry's shape lives in lib/provider-kinds.ts; it is re-exported here so
// a platform module imports one module for the common part and its own for the
// rest. The plan view is here because two platforms report a plan and both want
// the same shape — and because the video windows are dropped in one place.

import type { TokenPlanView } from "../provider-kinds.ts";
import { isIgnoredPlanWindow } from "../cooldown.ts";

export {
  fromUpstreamStatus,
  registerKind,
  type BalanceLotView,
  type CreditLotView,
  type CredentialView,
  type HealthSnapshot,
  type QuotaView,
  type TokenPlanView,
} from "../provider-kinds.ts";
export { isIgnoredPlanWindow } from "../cooldown.ts";
export type { ProviderRow } from "../providers.ts";

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
