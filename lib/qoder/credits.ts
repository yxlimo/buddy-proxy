// lib/qoder/credits.ts — what the Qoder account has left.
//
// The plan's own credits, the ones bought on top of it, and the account's
// standing (the server says PASS, WAIT, or why it may not be used).

import { ENDPOINTS, REGION, USER_AGENT, ensureCredential, loadSession, loginHint, sessionPath, type QoderRegion } from "./auth.ts";

export interface QoderAccountHealth {
  region: QoderRegion;
  authorized: boolean;
  /** PASS / WAIT / NoIpPermission / AppDisable / LoginExpire, as the server reports it. */
  whitelistStatus?: string;
  userId?: string;
  userType?: string;
  /** True when the account is fine to use. */
  usable: boolean;
  /** Why not, in a sentence. */
  reason?: string;
  hint?: string;
}

/** What the account has left, in credits. */
export interface QoderCredits {
  region: QoderRegion;
  /** The plan's own credits. */
  plan: { total: number; used: number; remaining: number };
  /** Credits bought on top of the plan. */
  addOn: { total: number; used: number; remaining: number };
  /** Whether the plan's credits are used up. */
  quotaExceeded: boolean;
  /** When the plan's credits reset. */
  resetsAt: string | null;
}

/**
 * Ask the account how many credits it has left.
 *
 * GET /api/v2/quota/usage on the openapi host, with the same token the status
 * check uses. The answer holds two pots: the plan's own credits and the ones
 * bought on top of it.
 */
export async function fetchQoderCredits(region: QoderRegion = REGION): Promise<QoderCredits | null> {
  const session = loadSession(region);
  if (!session) return null;
  try {
    const cred = await ensureCredential(false, region);
    const r = await fetch(`${ENDPOINTS[region].openapi}/api/v2/quota/usage`, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(session.machineToken ? { "Cosy-MachineToken": session.machineToken } : {}),
        ...(session.machineType ? { "Cosy-Machine-Type": session.machineType } : {}),
      },
    });
    if (!r.ok) return null;
    const body = await r.json().catch(() => undefined);
    const pot = (p: any) => ({
      total: Number(p?.total ?? 0),
      used: Number(p?.used ?? 0),
      remaining: Number(p?.remaining ?? 0),
    });
    return {
      region,
      plan: pot(body?.userQuota),
      addOn: pot(body?.addOnQuota),
      quotaExceeded: body?.isQuotaExceeded === true,
      resetsAt: typeof body?.expiresAt === "number" ? new Date(body.expiresAt).toISOString() : null,
    };
  } catch {
    return null;
  }
}

export async function checkAccountHealth(region: QoderRegion = REGION): Promise<QoderAccountHealth> {
  const session = loadSession(region);
  if (!session) {
    return { region, authorized: false, usable: false, reason: "no session", hint: loginHint(region) };
  }
  const cred = await ensureCredential(false, region);
  const r = await fetch(`${ENDPOINTS[region].openapi}/api/v3/user/status`, {
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(session.machineToken ? { "Cosy-MachineToken": session.machineToken } : {}),
      ...(session.machineType ? { "Cosy-Machine-Type": session.machineType } : {}),
    },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => undefined);
    const code = body?.errorCode ?? body?.code ?? `HTTP ${r.status}`;
    return {
      region,
      authorized: false,
      usable: false,
      reason: `status check failed (${code})`,
      hint: `Qoder 账号状态查询失败（${code}）。`,
    };
  }
  const body = await r.json().catch(() => undefined);
  const userId = typeof body?.id === "string" ? body.id : undefined;
  const whitelistStatus = typeof body?.whitelistStatus === "string" ? body.whitelistStatus : undefined;
  const userType = typeof body?.userType === "string" ? body.userType : undefined;

  if (!userId) {
    return {
      region,
      authorized: false,
      usable: false,
      reason: "login expired",
      hint: `登录已失效，删掉 ${sessionPath(region)} 后重启服务即可重新登录。`,
    };
  }
  if (whitelistStatus === "NoIpPermission") {
    return {
      region,
      authorized: false,
      usable: false,
      whitelistStatus,
      userId,
      userType,
      reason: "the account may not be used from this IP",
      hint: "Qoder 拒绝了当前出口 IP（NoIpPermission）。换一个出口再试。",
    };
  }
  if (whitelistStatus === "AppDisable") {
    return { region, authorized: false, usable: false, whitelistStatus, userId, userType, reason: "the app is disabled for this account" };
  }
  if (whitelistStatus === "LoginExpire") {
    return {
      region,
      authorized: false,
      usable: false,
      whitelistStatus,
      userId,
      userType,
      reason: "login expired",
      hint: `登录已过期，删掉 ${sessionPath(region)} 后重启服务即可重新登录。`,
    };
  }
  return { region, authorized: true, usable: true, whitelistStatus, userId, userType };
}
