// lib/admin/accounts.ts — 账号与凭据：现在是从 secrets 表派生出来的视图。
//
// 真正的账号表还没有建，也不打算为了面板先做一次数据迁移：凭据现在就放在
// secrets 表里，id 已经说明了它是谁的（session:qoder:cn、account:tokenrhythm:1）。
// 这里只是把这些 id 读成一个面板能看的形状：哪个上游的哪个登录身份，手上有
// 几条凭据，每条的状态如何。
//
// 敏感的值只写不读：列表里给的是掩码与指纹。

import crypto from "node:crypto";
import {
  MAX_MINIMAX_API_TENANTS,
  miniMaxApiTenantSecretId,
} from "../minimax/api.ts";
import { listSecrets } from "../store.ts";
import { tokenFingerprint } from "../credential.ts";
import { miniMaxTokenPlanKey, fetchMiniMaxTokenPlan } from "../minimax/credits.ts";
import { readCredential, AUTH_MODE } from "../minimax/auth.ts";
import { refreshSession as refreshQoderSession } from "../qoder/auth.ts";
import { checkAccountHealth } from "../qoder/credits.ts";
import { refreshSession as refreshWorkBuddySession } from "../workbuddy/auth.ts";
import { fetchWorkBuddyCredits } from "../workbuddy/credits.ts";
import { login as loginTokenRhythm, sessionFor, tokenRhythmTenants } from "../tokenrhythm/accounts.ts";
import { wallet as tokenRhythmWallet } from "../tokenrhythm/wallet.ts";
import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { credentialStateText } from "./credentials.ts";

/** 一个账号：上游的一个登录身份。 */
export interface AccountView {
  id: string;
  upstreamId: string;
  label: string;
  /** 凭据的状态。 */
  status: CredentialState;
  credentialCount: number;
  detail: string;
}

/** 一条凭据。 */
export interface CredentialRow {
  id: string;
  accountId: string;
  upstreamId: string;
  /** session / api_key / login / plan_key */
  kind: string;
  label: string;
  /** 掩码后的值：只留前几位。 */
  masked: string;
  /** 值的指纹，用来认出「还是那一条」。 */
  fingerprint: string;
  /** 这条凭据的状态。 */
  status: CredentialState;
  generation: number;
  expiresAt: number;
  lastOkAt: number;
  lastError: string;
  updatedAt: number;
}

/**
 * 固定的账号：一个上游一个登录身份。
 *
 * SenseNova 与 intern-ai 也在里面：它们的登录是可以做的，面板上要有地方点。
 * 推理用的 key 也列在凭据里 —— 那是这两个上游真正干活的东西（cookie 只是
 * 登录态，读额度用的）。
 */
const FIXED_ACCOUNTS: { id: string; upstream: string; label: string }[] = [
  { id: "minimax", upstream: "minimax", label: "MiniMax Code" },
  { id: "qoder", upstream: "qoder", label: "Qoder（全球区）" },
  { id: "qoder-cn", upstream: "qoder-cn", label: "Qoder（中国区）" },
  { id: "workbuddy-cn", upstream: "workbuddy-cn", label: "WorkBuddy（中国区）" },
  { id: "zcode", upstream: "zcode", label: "ZCode" },
  { id: "sensenova", upstream: "sensenova", label: "SenseNova" },
  { id: "intern-ai", upstream: "intern-ai", label: "书生·端砚" },
];

/** 指纹：同一个值永远是同一个指纹，换一个值就是另一个。 */
function fingerprintOf(value: string): string {
  if (!value) return "";
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/** 掩码：只留前几位。 */
function maskOf(value: string): string {
  return value ? tokenFingerprint(value) : "";
}

/** 一条会话凭据的样子。 */
function sessionCredential(id: string, accountId: string, upstreamId: string, label: string): CredentialRow {
  const row = listSecrets(id).find((r) => r.id === id);
  const raw = row?.data as any;
  if (!raw) {
    return {
      id,
      accountId,
      upstreamId,
      kind: "session",
      label,
      masked: "",
      fingerprint: "",
      status: CredentialState.MISSING,
      generation: 0,
      expiresAt: 0,
      lastOkAt: 0,
      lastError: "",
      updatedAt: 0,
    };
  }
  // ZCode 的会话里令牌叫 token（zcode JWT），别的那几个叫 accessToken。
  const token = String(raw.accessToken ?? raw.cookie ?? raw.token ?? "");
  const expiresAt = Number(raw.expiresAtMs ?? 0);
  const expired = expiresAt > 0 && expiresAt <= Date.now();
  return {
    id,
    accountId,
    upstreamId,
    kind: "session",
    label,
    masked: maskOf(token),
    fingerprint: fingerprintOf(token),
    status: expired ? CredentialState.EXPIRED : CredentialState.USABLE,
    generation: Number(raw.generation ?? 0),
    expiresAt,
    lastOkAt: Number(raw.refreshedAtMs ?? raw.obtainedAtMs ?? raw.loginAtMs ?? 0),
    lastError: "",
    updatedAt: Number(row?.updatedAt ?? 0),
  };
}

/**
 * 账号的凭据。
 *
 * 一个账号下面有几条：一个登录会话、一把推理 key，也许还有一个 plan key。
 * 列表里只给已经配好的那些 —— 没配的东西不算凭据。
 */
export function credentialsOf(accountId: string): CredentialRow[] {
  const out: CredentialRow[] = [];
  switch (accountId) {
    case "minimax": {
      out.push(sessionCredential("session:minimax", "minimax", "minimax", "登录会话"));
      const key = miniMaxTokenPlanKey();
      if (key) {
        const row = listSecrets("key:minimax-token-plan").find((r) => r.id === "key:minimax-token-plan");
        out.push({
          id: "key:minimax-token-plan",
          accountId,
          upstreamId: "minimax",
          kind: "plan_key",
          label: "Plan key",
          masked: maskOf(key),
          fingerprint: fingerprintOf(key),
          status: CredentialState.USABLE,
          generation: 0,
          expiresAt: 0,
          lastOkAt: 0,
          lastError: "",
          updatedAt: Number(row?.updatedAt ?? 0),
        });
      }
      return out;
    }
    case "qoder":
      out.push(sessionCredential("session:qoder:global", "qoder", "qoder", "登录会话（全球区）"));
      return out;
    case "qoder-cn":
      out.push(sessionCredential("session:qoder:cn", "qoder-cn", "qoder-cn", "登录会话（中国区）"));
      return out;
    case "workbuddy-cn":
      out.push(sessionCredential("session:workbuddy:cn", "workbuddy-cn", "workbuddy-cn", "登录会话"));
      return out;
    case "zcode":
      out.push(sessionCredential("session:zcode", "zcode", "zcode", "登录会话"));
      return out;
    case "sensenova": {
      out.push(sessionCredential("session:sensenova", accountId, "sensenova", "登录会话"));
      const loginId = "account:sensenova";
      const loginRow = listSecrets(loginId).find((r) => r.id === loginId);
      const login = loginRow?.data as any;
      if (login?.user) {
        out.push({
          id: loginId,
          accountId,
          upstreamId: "sensenova",
          kind: "login",
          label: "登录账号",
          masked: maskOf(String(login.user)),
          fingerprint: fingerprintOf(String(login.user)),
          status: CredentialState.USABLE,
          generation: 0,
          expiresAt: 0,
          lastOkAt: 0,
          lastError: "",
          updatedAt: Number(loginRow?.updatedAt ?? 0),
        });
      }
      // 推理用的 key：推理端点要的是它，不是 cookie。
      const apiKey = String(login?.apiKey ?? "");
      if (apiKey) {
        out.push({
          id: `${loginId}#api_key`,
          accountId,
          upstreamId: "sensenova",
          kind: "api_key",
          label: "推理 key",
          masked: maskOf(apiKey),
          fingerprint: fingerprintOf(apiKey),
          status: CredentialState.USABLE,
          generation: 0,
          expiresAt: 0,
          lastOkAt: 0,
          lastError: "",
          updatedAt: Number(loginRow?.updatedAt ?? 0),
        });
      }
      return out;
    }
    case "intern-ai": {
      // 会话里是每个子站一份 token。
      const id = "session:intern-ai";
      const row = listSecrets(id).find((r) => r.id === id);
      const session = row?.data as any;
      const sites = Array.isArray(session?.sites) ? session.sites : [];
      const token = String(sites[0]?.token ?? "");
      out.push({
        id,
        accountId,
        upstreamId: "intern-ai",
        kind: "session",
        label: sites.length ? `子站 token（${sites.map((s: any) => s.name).join(" / ")}）` : "登录会话",
        masked: maskOf(token),
        fingerprint: fingerprintOf(token),
        status: token ? CredentialState.USABLE : CredentialState.MISSING,
        generation: 0,
        expiresAt: 0,
        lastOkAt: Number(session?.obtainedAtMs ?? 0),
        lastError: "",
        updatedAt: Number(row?.updatedAt ?? 0),
      });
      // 推理用的 key（Discovery 子站那把）：推理端点要的是它。
      const loginId = "account:intern-ai";
      const loginRow = listSecrets(loginId).find((r) => r.id === loginId);
      const login = loginRow?.data as any;
      const discoveryKey = String(login?.discoveryKey ?? "");
      if (discoveryKey) {
        out.push({
          id: `${loginId}#discovery_key`,
          accountId,
          upstreamId: "intern-ai",
          kind: "api_key",
          label: "推理 key（Discovery）",
          masked: maskOf(discoveryKey),
          fingerprint: fingerprintOf(discoveryKey),
          status: CredentialState.USABLE,
          generation: 0,
          expiresAt: 0,
          lastOkAt: 0,
          lastError: "",
          updatedAt: Number(loginRow?.updatedAt ?? 0),
        });
      }
      return out;
    }
  }
  // TokenRhythm：登录账号、推理 key、会话 cookie。
  const match = /^tokenrhythm:(\d+)$/.exec(accountId);
  if (!match) return out;
  const index = Number(match[1]);
  const loginId = `account:tokenrhythm:${index}`;
  const loginRow = listSecrets(loginId).find((r) => r.id === loginId);
  const login = loginRow?.data as any;
  if (login) {
    out.push({
      id: loginId,
      accountId,
      upstreamId: "tokenrhythm",
      kind: "login",
      label: "登录账号",
      masked: maskOf(String(login.account ?? "")),
      fingerprint: fingerprintOf(String(login.account ?? "")),
      status: login.account && login.password ? CredentialState.USABLE : CredentialState.MISSING,
      generation: 0,
      expiresAt: 0,
      lastOkAt: 0,
      lastError: "",
      updatedAt: Number(loginRow?.updatedAt ?? 0),
    });
    const key = String(login.apiKey ?? "");
    if (key) {
      out.push({
        id: `${loginId}#api_key`,
        accountId,
        upstreamId: "tokenrhythm",
        kind: "api_key",
        label: "推理 key",
        masked: maskOf(key),
        fingerprint: fingerprintOf(key),
        status: CredentialState.USABLE,
        generation: 0,
        expiresAt: 0,
        lastOkAt: 0,
        lastError: "",
        updatedAt: Number(loginRow?.updatedAt ?? 0),
      });
    }
  }
  out.push(sessionCredential(`session:tokenrhythm:${index}`, accountId, "tokenrhythm", "会话 cookie"));
  return out;
}

/** 所有账号。TokenRhythm 的账号是租户，一个租户一个。 */
export function listAccounts(): AccountView[] {
  const out: AccountView[] = [];
  for (const account of FIXED_ACCOUNTS) {
    const credentials = credentialsOf(account.id);
    const sessions = credentials.filter((c) => c.kind === "session");
    const session = sessions[0];
    out.push({
      id: account.id,
      upstreamId: account.upstream,
      label: account.label,
      status: session ? session.status : CredentialState.MISSING,
      credentialCount: credentials.length,
      detail: session ? `会话 ${credentialStateText(session.status)}` : "暂无凭据",
    });
  }
  for (const tenant of tokenRhythmTenants()) {
    const accountId = `tokenrhythm:${tenant.index}`;
    const credentials = credentialsOf(accountId);
    const session = credentials.find((c) => c.kind === "session");
    out.push({
      id: accountId,
      upstreamId: "tokenrhythm",
      label: `TokenRhythm 租户 ${tenant.index}`,
      status: session ? session.status : CredentialState.MISSING,
      credentialCount: credentials.length,
      detail: session ? `会话 ${credentialStateText(session.status)}` : "暂无登录态",
    });
  }
  return out;
}

/** 凭据列表。不给账号就是全部。 */
export function listCredentials(accountId = ""): CredentialRow[] {
  const accounts = accountId ? [accountId] : listAccounts().map((a) => a.id);
  const out: CredentialRow[] = [];
  for (const id of accounts) out.push(...credentialsOf(id));
  return out;
}

/** 凭据在不在。 */
export function credentialExists(id: string): boolean {
  return listCredentials().some((c) => c.id === id);
}

/* ------------------------------------------------------------------ *
 * 试一下 / 刷新一下
 * ------------------------------------------------------------------ */

/** 试一条凭据还能不能用。 */
export async function testCredential(id: string): Promise<{ ok: boolean; message: string }> {
  try {
    if (id === "session:minimax") {
      const cred = await readCredential();
      return { ok: true, message: `能用，第 ${cred.generation} 代，还剩 ${Math.round(cred.remainingMs / 60000)} 分钟` };
    }
    if (id === "key:minimax-token-plan") {
      const key = miniMaxTokenPlanKey();
      if (!key) return { ok: false, message: "未配置 plan key" };
      const plan = await fetchMiniMaxTokenPlan(key);
      return plan
        ? { ok: true, message: `plan 额度读到了（${plan.windows.length} 个窗口）` }
        : { ok: false, message: "无法读取 plan 额度，key 可能不正确" };
    }
    const qoder = /^session:qoder:(global|cn)$/.exec(id);
    if (qoder) {
      const region = qoder[1] as "global" | "cn";
      const health = await checkAccountHealth(region);
      return health.usable
        ? { ok: true, message: `账号可用（${health.whitelistStatus ?? "PASS"}）` }
        : { ok: false, message: health.reason || health.hint || "账号不可用" };
    }
    if (id === "session:workbuddy:cn") {
      const credits = await fetchWorkBuddyCredits();
      return credits
        ? { ok: true, message: `能用，今日已签到：${credits.checkedIn ? "是" : "否"}` }
        : { ok: false, message: "无法读取签到状态" };
    }
    const tr = /^(?:session|account):tokenrhythm:(\d+)/.exec(id);
    if (tr) {
      const index = Number(tr[1]);
      const session = await sessionFor(index);
      const w = await tokenRhythmWallet(session);
      return { ok: true, message: `能登录，可用余额 ${w.availableCny} ${w.currency}` };
    }
    return { ok: false, message: `不认识的凭据：${id}` };
  } catch (e) {
    return { ok: false, message: (e as Error)?.message ?? "试不了" };
  }
}

/** 强制刷新一条凭据。 */
export async function refreshCredential(id: string): Promise<{ ok: boolean; message: string; generation: number }> {
  try {
    if (id === "session:minimax") {
      if (AUTH_MODE === "file") {
        return { ok: false, message: "当前读的是桌面端的 store，刷新由桌面端负责", generation: 0 };
      }
      const cred = await readCredential(true);
      return { ok: true, message: `刷新好了，第 ${cred.generation} 代`, generation: cred.generation };
    }
    const qoder = /^session:qoder:(global|cn)$/.exec(id);
    if (qoder) {
      const region = qoder[1] as "global" | "cn";
      const session = await refreshQoderSession(true, region);
      return { ok: true, message: `刷新好了，第 ${session.generation} 代`, generation: session.generation };
    }
    if (id === "session:workbuddy:cn") {
      const session = await refreshWorkBuddySession(true, "cn");
      return { ok: true, message: `刷新好了，第 ${session.generation} 代`, generation: session.generation };
    }
    const tr = /^account:tokenrhythm:(\d+)$/.exec(id);
    if (tr) {
      const index = Number(tr[1]);
      const tenant = tokenRhythmTenants().find((t) => t.index === index);
      if (!tenant) return { ok: false, message: `没有第 ${index} 个租户`, generation: 0 };
      await loginTokenRhythm(tenant);
      return { ok: true, message: "重新登录完成", generation: 0 };
    }
    return { ok: false, message: `这条凭据不能刷新：${id}`, generation: 0 };
  } catch (e) {
    const err = e as { message?: string; hint?: string };
    return { ok: false, message: err?.hint ? `${err.message}：${err.hint}` : err?.message ?? "刷不了", generation: 0 };
  }
}
