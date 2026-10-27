// lib/admin/accounts.ts — 账号与凭据：一家一行的账号，加上它名下的凭据。
//
// 账号就是 provider 表的一行（lib/providers.ts），凭据挂在它下面：secrets 表
// 里的 id 已经说明了它是谁的（session:provider:<账号>、key:provider:<账号>:<后缀>）。
// 这里把那些 id 读成一个面板能看的形状：这个账号手上有几条凭据，每条的状态如何。
//
// 敏感的值只写不读：列表里给的是掩码与指纹。

import crypto from "node:crypto";
import { miniMaxApiTenantSecretId, miniMaxApiTenants } from "../minimax/api.ts";
import { deleteProviderCredentials, deleteProviderRow, listProviders, provider } from "../providers.ts";
import { getSecret, listSecrets } from "../store.ts";
import { clearDeadSession, deadSession } from "../session.ts";
import { tokenFingerprint } from "../credential.ts";
import { miniMaxTokenPlanKey, fetchMiniMaxTokenPlan } from "../minimax/credits.ts";
import { readCredential } from "../minimax/auth.ts";
import { loadSession as loadQoderSession } from "../qoder/auth.ts";
import { checkAccountHealth } from "../qoder/credits.ts";
import { loadSession as loadWorkBuddySession } from "../workbuddy/auth.ts";
import { fetchWorkBuddyCredits } from "../workbuddy/credits.ts";
import { zcodeStatus } from "../zcode/auth.ts";
import { senseNovaInferenceKey } from "../sensenova/transport.ts";
import { internAiInferenceKey } from "../intern-ai/transport.ts";
import {
  forgetLegacyTenantRecords,
  forgetTokenRhythmCredential,
  loadSession as loadTokenRhythmSession,
  login as loginTokenRhythm,
  sessionId as tokenRhythmSessionId,
  tokenRhythmCredentialOf,
} from "../tokenrhythm/accounts.ts";
import { wallet as tokenRhythmWallet } from "../tokenrhythm/wallet.ts";
import { forgetAccountSnapshot } from "./upstreams.ts";
import { clearCooldown } from "../cooldown.ts";
import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { credentialStateText, parseCredentialId } from "./credentials.ts";
import type { ProviderRow } from "../providers.ts";

/** 一个账号：provider 表的一行，也就是一份登录身份。 */
export interface AccountView {
  id: string;
  /** 它属于哪个平台：九个模板之一。 */
  platform: string;
  /** 面板上用来分辨同平台的两个账号。 */
  alias: string;
  /** 凭据的状态。 */
  status: CredentialState;
  credentialCount: number;
  detail: string;
  /** 开关。关着的账号不参与选路。 */
  enabled: boolean;
  /** 权重：大的先试。 */
  weight: number;
  /** 建出来的时刻，Unix 毫秒。 */
  createdAt: number;
}

/** 一条凭据。 */
export interface CredentialRow {
  id: string;
  accountId: string;
  /** 账号属于哪个平台。凭据挂在账号上，平台是它所在的那一层。 */
  platform: string;
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

/** 指纹：同一个值永远是同一个指纹，换一个值就是另一个。 */
function fingerprintOf(value: string): string {
  if (!value) return "";
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/** 掩码：只留前几位。 */
function maskOf(value: string): string {
  return value ? tokenFingerprint(value) : "";
}

/** 一条会话凭据的样子。会话里的东西各家不一样，所以值由外面给。 */
function sessionRow(
  id: string,
  account: ProviderRow,
  label: string,
  raw: any,
  updatedAt = 0,
): CredentialRow {
  if (!raw) {
    return {
      id,
      accountId: account.id,
      platform: account.platform,
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
  // 平台拒过这份会话：它已经作废了，重新授权才有新的。
  const refused = deadSession(id);
  return {
    id,
    accountId: account.id,
    platform: account.platform,
    kind: "session",
    label,
    masked: maskOf(token),
    fingerprint: fingerprintOf(token),
    status: refused || expired ? CredentialState.EXPIRED : CredentialState.USABLE,
    generation: Number(raw.generation ?? 0),
    expiresAt,
    lastOkAt: Number(raw.refreshedAtMs ?? raw.obtainedAtMs ?? raw.loginAtMs ?? 0),
    lastError: refused ? "这份会话已经失效，需要重新授权" : "",
    updatedAt,
  };
}

/** 一条不带会话的凭据（key、登录账号）。 */
function plainRow(
  id: string,
  account: ProviderRow,
  form: string,
  label: string,
  value: string,
  updatedAt = 0,
): CredentialRow {
  return {
    id,
    accountId: account.id,
    platform: account.platform,
    kind: form,
    label,
    masked: maskOf(value),
    fingerprint: fingerprintOf(value),
    status: value ? CredentialState.USABLE : CredentialState.MISSING,
    generation: 0,
    expiresAt: 0,
    lastOkAt: 0,
    lastError: "",
    updatedAt,
  };
}

/** secrets 表里那一行的内容。 */
function secretOf(id: string): { data: any; updatedAt: number } {
  const row = listSecrets(id).find((r) => r.id === id);
  return { data: row?.data ?? null, updatedAt: Number(row?.updatedAt ?? 0) };
}

/**
 * 一个账号的凭据。
 *
 * 账号下面有几条：一个登录会话、一把推理 key，也许还有一个 plan key。列表里
 * 只给已经配好的那些 —— 没配的东西不算凭据。
 *
 * 账号的 id 就是 provider 表那一行的 id，所以这里不看别的东西：先按 id 取行，
 * 行说它是哪个平台的，平台说它的凭据长什么样。
 */
export function credentialsOf(accountId: string): CredentialRow[] {
  const out: CredentialRow[] = [];
  const account = provider(accountId);
  if (!account) return out;
  switch (account.kind) {
    case "minimax": {
      const sessionId = `session:provider:${account.id}`;
      const session = secretOf(sessionId);
      out.push(sessionRow(sessionId, account, "登录会话", session.data, session.updatedAt));
      const key = miniMaxTokenPlanKey(account.id);
      if (key) {
        const keyId = `key:provider:${account.id}:plan`;
        const keyRow = secretOf(keyId);
        out.push(plainRow(keyId, account, "plan_key", "Plan key", key, keyRow.updatedAt));
      }
      return out;
    }
    case "minimax-api": {
      // 开放平台：一个账号下可以有几把 key，一把 key 一个配额。
      for (const t of miniMaxApiTenants(account.id)) {
        const keyId = miniMaxApiTenantSecretId(t.index, account.id);
        const keyRow = secretOf(keyId);
        out.push(plainRow(keyId, account, "api_key", `key ${t.index}`, t.key, keyRow.updatedAt));
      }
      return out;
    }
    case "qoder":
    case "workbuddy":
    case "zcode": {
      const sessionId = `session:provider:${account.id}`;
      const session = secretOf(sessionId);
      out.push(sessionRow(sessionId, account, "登录会话", session.data, session.updatedAt));
      return out;
    }
    case "sensenova": {
      const sessionId = `session:provider:${account.id}`;
      const session = secretOf(sessionId);
      out.push(sessionRow(sessionId, account, "登录会话", session.data, session.updatedAt));
      const loginId = `key:provider:${account.id}:account`;
      const loginRow = secretOf(loginId);
      const login = loginRow.data;
      if (login?.user) {
        out.push(plainRow(loginId, account, "login", "登录账号", String(login.user), loginRow.updatedAt));
      }
      // 推理用的 key：推理端点要的是它，不是 cookie。
      const apiKey = String(login?.apiKey ?? "");
      if (apiKey) {
        out.push({
          ...plainRow(`${loginId}#api_key`, account, "api_key", "推理 key", apiKey, loginRow.updatedAt),
        });
      }
      return out;
    }
    case "intern-ai": {
      // 会话里是每个子站一份 token。
      const sessionId = `session:provider:${account.id}`;
      const sessionRowData = secretOf(sessionId);
      const session = sessionRowData.data;
      const sites = Array.isArray(session?.sites) ? session.sites : [];
      const token = String(sites[0]?.token ?? "");
      out.push({
        ...plainRow(
          sessionId,
          account,
          "session",
          sites.length ? `子站 token（${sites.map((s: any) => s.name).join(" / ")}）` : "登录会话",
          token,
          sessionRowData.updatedAt,
        ),
        status: token ? CredentialState.USABLE : CredentialState.MISSING,
        lastOkAt: Number(session?.obtainedAtMs ?? 0),
      });
      // 推理用的 key（Discovery 子站那把）：推理端点要的是它。
      const loginId = `key:provider:${account.id}:account`;
      const loginRow = secretOf(loginId);
      const discoveryKey = String(loginRow.data?.discoveryKey ?? "");
      if (discoveryKey) {
        out.push(
          plainRow(`${loginId}#discovery_key`, account, "api_key", "推理 key（Discovery）", discoveryKey, loginRow.updatedAt),
        );
      }
      return out;
    }
    case "tokenrhythm": {
      // 一个账号一个钱包：登录账号一份、会话一份、推理 key 一份。
      const credential = tokenRhythmCredentialOf(account.id);
      if (credential?.account) {
        const loginId = `key:provider:${account.id}:account`;
        const loginRow = secretOf(loginId);
        out.push({
          ...plainRow(loginId, account, "login", "登录账号", credential.account, loginRow.updatedAt),
          status:
            credential.account && credential.password
              ? CredentialState.USABLE
              : CredentialState.MISSING,
        });
      }
      const key = String(credential?.apiKey ?? "");
      if (key) {
        out.push({
          ...plainRow(`key:provider:${account.id}:account#api_key`, account, "api_key", "推理 key", key),
        });
      }
      const sessionId = tokenRhythmSessionId(account.id);
      out.push(sessionRow(sessionId, account, "会话 cookie", loadTokenRhythmSession(account.id)));
      return out;
    }
    default:
      return out;
  }
}

/**
 * 所有账号：provider 表里的每一行。
 *
 * 以前中转站的账号是「上游:租户号」拼出来的，要在这里展开；现在一个账号就是
 * 一行，所以这里只读表。
 */
export function listAccounts(): AccountView[] {
  const out: AccountView[] = [];
  for (const row of listProviders()) {
    const credentials = credentialsOf(row.id);
    const sessions = credentials.filter((c) => c.kind === "session");
    const session = sessions[0];
    // 账号的状态：有一条能用的凭据就算登录了。
    //
    // 开放平台的凭据是 key（不是会话），只认会话的话，那个账号明明有 key 却
    // 一直说「没有凭据」。
    const usable = credentials.filter(
      (c) => c.status === CredentialState.USABLE || c.status === CredentialState.AUTHENTICATED,
    );
    const status = session
      ? session.status
      : usable.length
        ? CredentialState.USABLE
        : CredentialState.MISSING;
    out.push({
      id: row.id,
      platform: row.platform,
      alias: row.alias,
      status,
      credentialCount: credentials.length,
      detail: session
        ? `会话 ${credentialStateText(session.status)}`
        : usable.length
          ? "有可用的 key"
          : "暂无凭据",
      enabled: row.enabled,
      weight: row.weight,
      createdAt: row.createdAt,
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

/**
 * 注销：把一个账号的凭据删掉。
 *
 * 账号的 id 就是 provider 表那一行的 id。凭据跟着账号走：会话、key，中转站旧
 * 库里按序号存的那一份也一起删 —— 不删它，下一次读又搬回来。
 */
export function logoutAccount(accountId: string): { ok: boolean; message: string; removed: number } {
  const id = String(accountId ?? "").trim();
  if (!id) return { ok: false, message: "要一个账号 id", removed: 0 };
  const row = provider(id);
  if (!row) return { ok: false, message: `没有这个账号：${id}`, removed: 0 };
  const removed = forgetAccountRecords(id, row.kind);
  if (!removed) return { ok: true, message: "这个账号本来就没有凭据", removed: 0 };
  console.log(`[ADMIN] ${id} 注销了，删掉 ${removed} 条凭据`);
  return { ok: true, message: `注销了，删掉 ${removed} 条凭据`, removed };
}

/**
 * 一个账号的凭据，删干净。
 *
 * 三处都要删：账号自己名下那些、旧库按租户号存的那一份、健康快照里它的那段。
 * 少删一处，那个账号就会带着旧身份回来 —— 旧记录会被搬回来，快照里的额度会
 * 继续显示着一个已经不存在的账号。
 */
export function forgetAccountRecords(accountId: string, kind?: string): number {
  let removed = deleteProviderCredentials(accountId);
  // 旧位置的记录（按租户号存的那份）也要删：留着它，启动时的归位会把账号
  // 带回来 —— 删了又活，凭据还串着。
  removed += forgetLegacyTenantRecords(accountId);
  forgetAccountSnapshot(accountId);
  if (kind === "tokenrhythm") removed += forgetTokenRhythmCredential(accountId);
  // 冷却也一起删：账号 id 会被复用（下一个账号接着排队），留着这一行，新账号
  // 开局就在冷却里 —— 面板说它可用，网关说它冷却中。
  try {
    clearCooldown(accountId);
  } catch (e) {
    console.warn(`[ADMIN] ${accountId} 的冷却删不掉：${(e as Error)?.message}`);
  }
  return removed;
}

/**
 * 删一个账号：行与凭据一起。
 *
 * 凭据由 forgetAccountRecords 删干净 —— 那里知道每个平台的凭据放在哪。
 */
export function deleteAccount(accountId: string): { ok: boolean; message: string; removed: number } {
  const id = String(accountId ?? "").trim();
  if (!id) return { ok: false, message: "要一个账号 id", removed: 0 };
  const row = provider(id);
  if (!row) return { ok: false, message: `没有这个账号：${id}`, removed: 0 };
  const removed = forgetAccountRecords(id, row.kind);
  deleteProviderRow(id);
  console.log(`[ADMIN] ${id} 删了，连 ${removed} 条凭据一起`);
  return { ok: true, message: removed > 0 ? `删掉了，连 ${removed} 条凭据一起` : "删掉了", removed };
}

/* ------------------------------------------------------------------ *
 * 试一下 / 刷新一下
 * ------------------------------------------------------------------ */

/**
 * 一条凭据 id 指向的东西。
 *
 * 面板把凭据的 id 原样交回来，所以这里是唯一的算法：id 先读成「哪个账号、
 * 哪一种」，再按账号的种类决定怎么试。
 */
interface CredentialTarget {
  account: ProviderRow;
  /** session / plan_key / api_key / login。 */
  form: string;
  /** 第几把 key（开放平台一把 key 一个配额）。 */
  tenant: number | null;
  /** 从登录账号里派生出来的那条。 */
  derived: string;
}

/** 试一条凭据还能不能用。 */
export async function testCredential(id: string): Promise<{ ok: boolean; message: string }> {
  const target = targetOf(id);
  if (!target.ok) return { ok: false, message: target.message };
  try {
    return await testTarget(target.value);
  } catch (e) {
    return { ok: false, message: (e as Error)?.message ?? "试不了" };
  }
}

/** 凭据 id → 它指向的账号与形态。 */
function targetOf(id: string): { ok: true; value: CredentialTarget } | { ok: false; message: string } {
  const ref = parseCredentialId(id);
  if (!ref) return { ok: false, message: `不认识的凭据：${id}` };
  const row = provider(ref.accountId);
  if (!row) return { ok: false, message: `没有这个账号：${ref.accountId}` };
  return {
    ok: true,
    value: {
      account: row,
      // 派生出来的那一条是从登录账号里取的：它算一条 key，不算账号。
      form: ref.derived ? "api_key" : ref.form,
      tenant: ref.tenant,
      derived: ref.derived,
    },
  };
}

/**
 * 按账号的种类试一条凭据。
 *
 * 各家能问的东西不一样：有的问账号状态，有的问额度，有的问钱包。
 */
async function testTarget(target: CredentialTarget): Promise<{ ok: boolean; message: string }> {
  const p = target.account;
  switch (p.kind) {
    case "minimax": {
      if (target.form === "plan_key") {
        const key = miniMaxTokenPlanKey(p.id);
        if (!key) return { ok: false, message: "未配置 plan key" };
        const plan = await fetchMiniMaxTokenPlan(key);
        return plan
          ? { ok: true, message: `plan 额度读到了（${plan.windows.length} 个窗口）` }
          : { ok: false, message: "无法读取 plan 额度，key 可能不正确" };
      }
      const cred = await readCredential(p.id);
      return {
        ok: true,
        message: `能用，第 ${cred.generation} 代，还剩 ${Math.round(cred.remainingMs / 60000)} 分钟`,
      };
    }
    case "qoder": {
      const health = await checkAccountHealth(p.id);
      return health.usable
        ? { ok: true, message: `账号可用（${health.whitelistStatus ?? "PASS"}）` }
        : { ok: false, message: health.reason || health.hint || "账号不可用" };
    }
    case "workbuddy": {
      const credits = await fetchWorkBuddyCredits(p.id);
      return credits
        ? { ok: true, message: `能用，今日已签到：${credits.checkedIn ? "是" : "否"}` }
        : { ok: false, message: "无法读取签到状态" };
    }
    case "zcode": {
      // ZCode 的令牌没有刷新通道，过期了只能重登，所以这里只能看它还在不在。
      const status = zcodeStatus(p.id);
      const state = String(status.status ?? "");
      if (state === "authenticated") return { ok: true, message: "能用" };
      if (state === "expired") return { ok: false, message: "令牌过期了，要重新登录" };
      return { ok: false, message: "没有登录 ZCode" };
    }
    case "sensenova": {
      // 登录凭据、推理 key 与会话是三回事，说的也要是三回事：登录凭据说的是
      // 登录态，推理 key 说的是干活的那把钥匙，会话说的是登录态本身。
      if (target.form === "login") {
        const account = getSecret<{ user?: string }>(`key:provider:${p.id}:account`);
        return account?.user
          ? { ok: true, message: "登录账号已配置" }
          : { ok: false, message: "没有配置登录账号" };
      }
      if (target.form === "session") {
        const session = getSecret<{ accessToken?: string }>(`session:provider:${p.id}`);
        return session?.accessToken
          ? { ok: true, message: "登录会话还在" }
          : { ok: false, message: "没有登录会话" };
      }
      const key = senseNovaInferenceKey(p.id);
      return key
        ? { ok: true, message: "推理 key 已配置" }
        : { ok: false, message: "没有配置推理 key" };
    }
    case "intern-ai": {
      if (target.form === "login") {
        const account = getSecret<{ user?: string }>(`key:provider:${p.id}:account`);
        return account?.user
          ? { ok: true, message: "登录账号已配置" }
          : { ok: false, message: "没有配置登录账号" };
      }
      if (target.form === "session") {
        const session = getSecret<{ sites?: unknown[] }>(`session:provider:${p.id}`);
        return session?.sites?.length
          ? { ok: true, message: "登录会话还在" }
          : { ok: false, message: "没有登录会话" };
      }
      const key = internAiInferenceKey(p.id);
      return key
        ? { ok: true, message: "推理 key（Discovery）已配置" }
        : { ok: false, message: "没有配置推理 key（Discovery）" };
    }
    case "minimax-api": {
      if (target.tenant === null) return { ok: false, message: "这条凭据没有序号" };
      const tenant = miniMaxApiTenants(p.id).find((t) => t.index === target.tenant);
      return tenant
        ? { ok: true, message: `key ${tenant.index} 已配置` }
        : { ok: false, message: `没有第 ${target.tenant} 把 key` };
    }
    case "tokenrhythm": {
      const credential = tokenRhythmCredentialOf(p.id);
      if (!credential) return { ok: false, message: "这个账号没有配置凭据" };
      if (target.form === "api_key") {
        return credential.apiKey
          ? { ok: true, message: "推理 key 已配置" }
          : { ok: false, message: "没有推理 key" };
      }
      if (target.form === "login") {
        return credential.account && credential.password
          ? { ok: true, message: "登录账号已配置" }
          : { ok: false, message: "登录账号不完整" };
      }
      // 会话：先看有没有存着的会话（本地），有才去问平台。
      const session = loadTokenRhythmSession(p.id);
      if (!session) return { ok: false, message: "这个账号没有登录态" };
      const w = await tokenRhythmWallet(session);
      return { ok: true, message: `能登录，可用余额 ${w.availableCny} ${w.currency}` };
    }
    default:
      return { ok: false, message: `这个账号不能试凭据：${p.id}` };
  }
}

/** 强制刷新一条凭据。 */
export async function refreshCredential(
  id: string,
): Promise<{ ok: boolean; message: string; generation: number }> {
  const target = targetOf(id);
  if (!target.ok) return { ok: false, message: target.message, generation: 0 };
  try {
    return await refreshTarget(target.value, id);
  } catch (e) {
    const err = e as { message?: string; hint?: string };
    return {
      ok: false,
      message: err?.hint ? `${err.message}：${err.hint}` : err?.message ?? "刷不了",
      generation: 0,
    };
  }
}

/** 按账号的种类刷新一条凭据。 */
async function refreshTarget(
  target: CredentialTarget,
  id: string,
): Promise<{ ok: boolean; message: string; generation: number }> {
  const p = target.account;
  // 操作者主动点了「刷新一下」：就算平台刚才拒过，也再试一次。
  clearDeadSession(`session:provider:${p.id}`);
  switch (p.kind) {
    case "minimax": {
      // 会话由服务定时刷新（客户端就是这么干的），手动刷新没有意义；
      // 失效了的会话只能重新授权。
      const cred = await readCredential(p.id);
      if (cred.status !== "authenticated") {
        return { ok: false, message: "这份会话已经失效，需要重新登录（面板上登录一次）", generation: cred.generation };
      }
      return { ok: true, message: `会话由服务定时刷新（第 ${cred.generation} 代，还剩 ${Math.round(cred.remainingMs / 60000)} 分钟）`, generation: cred.generation };
    }
    case "qoder": {
      // 只读现在这一份：换令牌是定时器的事，这里换了就跟定时器撞上了。
      const session = loadQoderSession(p.id);
      if (!session) return { ok: false, message: "没有登录，在面板上登录一次", generation: 0 };
      return { ok: true, message: `会话由服务定时刷新（第 ${session.generation} 代）`, generation: session.generation };
    }
    case "workbuddy": {
      const session = loadWorkBuddySession(p.id);
      if (!session) return { ok: false, message: "没有登录，在面板上登录一次", generation: 0 };
      return { ok: true, message: `会话由服务定时刷新（第 ${session.generation} 代）`, generation: session.generation };
    }
    case "zcode":
      // ZCode 的令牌是 JWT，没有刷新通道：过期了只能重登。
      return { ok: false, message: "ZCode 的令牌没有刷新通道，过期了要重新登录", generation: 0 };
    case "tokenrhythm": {
      await loginTokenRhythm(p.id);
      return { ok: true, message: "重新登录完成", generation: 0 };
    }
    default:
      return { ok: false, message: `这条凭据不能刷新：${id}`, generation: 0 };
  }
}
