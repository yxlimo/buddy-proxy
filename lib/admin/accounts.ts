// lib/admin/accounts.ts — 账号与凭据：现在是从 secrets 表派生出来的视图。
//
// 真正的账号表还没有建，也不打算为了面板先做一次数据迁移：凭据现在就放在
// secrets 表里，id 已经说明了它是谁的（session:provider:<上游>、
// key:provider:<上游>:<后缀>）。
// 这里只是把这些 id 读成一个面板能看的形状：哪个上游的哪个登录身份，手上有
// 几条凭据，每条的状态如何。
//
// 敏感的值只写不读：列表里给的是掩码与指纹。

import crypto from "node:crypto";
import { miniMaxApiTenantSecretId, miniMaxApiTenants } from "../minimax/api.ts";
import { listProviders, provider } from "../providers.ts";
import { deleteSecret, getSecret, listSecrets } from "../store.ts";
import { deleteProviderCredentials, providerSecretId } from "../providers.ts";
import { clearDeadSession, deadSession } from "../session.ts";
import { tokenFingerprint } from "../credential.ts";
import { miniMaxTokenPlanKey, fetchMiniMaxTokenPlan } from "../minimax/credits.ts";
import { readCredential } from "../minimax/auth.ts";
import { refreshSession as refreshQoderSession } from "../qoder/auth.ts";
import { checkAccountHealth } from "../qoder/credits.ts";
import { refreshSession as refreshWorkBuddySession } from "../workbuddy/auth.ts";
import { fetchWorkBuddyCredits } from "../workbuddy/credits.ts";
import { zcodeStatus } from "../zcode/auth.ts";
import { senseNovaInferenceKey } from "../sensenova/transport.ts";
import { internAiInferenceKey } from "../intern-ai/transport.ts";
import {
  forgetSession,
  loadSession,
  login as loginTokenRhythm,
  tokenRhythmTenantSecretId,
  tokenRhythmTenants,
  type TokenRhythmTenantSessions,
} from "../tokenrhythm/accounts.ts";
import { wallet as tokenRhythmWallet } from "../tokenrhythm/wallet.ts";
import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { credentialStateText, parseCredentialId, splitAccountId } from "./credentials.ts";
import { readEnvValue } from "../env.ts";
import type { ProviderRow } from "../providers.ts";

/**
 * 中转站内置的那个 provider 的 id。
 *
 * 旧的那一份凭据（account:tokenrhythm:<n>）是全局的，只归它 —— 读账号的那
 * 一步只对内置的这个上游回落读旧 id。
 */
const TOKENRHYTHM_BUILT_IN = "tokenrhythm";

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
 * 账号（provider）：上游名下的一个账号。
 *
 * 术语按 AGENTS.md：upstream 是上游的 API，provider 是它名下的一个账号。
 * 代码里的 provider 表存的是**上游**（一行一个上游服务），账号的 id 就是
 * 上游的 id —— 面板上的每条凭据都挂在它下面。
 * 凭据本身是 secrets 表里的行，id 说明了它是谁的
 * （session:provider:<id>、key:provider:<id>:<后缀>）。
 */

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
  accountId: string,
  upstreamId: string,
  label: string,
  raw: any,
  updatedAt = 0,
): CredentialRow {
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
  // 平台拒过这份会话：它已经作废了，重新授权才有新的。
  const refused = deadSession(id);
  return {
    id,
    accountId,
    upstreamId,
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

/** secrets 表里那一行的内容。 */
function secretOf(id: string): { data: any; updatedAt: number } {
  const row = listSecrets(id).find((r) => r.id === id);
  return { data: row?.data ?? null, updatedAt: Number(row?.updatedAt ?? 0) };
}

/**
 * 账号的凭据。
 *
 * 一个账号下面有几条：一个登录会话、一把推理 key，也许还有一个 plan key。
 * 列表里只给已经配好的那些 —— 没配的东西不算凭据。
 *
 * 账号的 id 是上游自己的 id，或者是「上游:租户号」那种（中转站一个租户一个
 * 账号）。
 */
export function credentialsOf(accountId: string): CredentialRow[] {
  const out: CredentialRow[] = [];
  // The account belongs to an upstream: the upstream says which kind it is,
  // and the kind says what its credentials look like.
  const { providerId, tenant } = splitAccountId(accountId);
  const row = provider(providerId);
  if (row) {
    switch (row.kind) {
      case "minimax": {
        const sessionId = `session:provider:${row.id}`;
        const session = secretOf(sessionId);
        out.push(sessionRow(sessionId, row.id, row.id, "登录会话", session.data, session.updatedAt));
        const key = miniMaxTokenPlanKey(row.id);
        if (key) {
          const keyId = `key:provider:${row.id}:plan`;
          const keyRow = secretOf(keyId);
          out.push({
            id: keyId,
            accountId: row.id,
            upstreamId: row.id,
            kind: "plan_key",
            label: "Plan key",
            masked: maskOf(key),
            fingerprint: fingerprintOf(key),
            status: CredentialState.USABLE,
            generation: 0,
            expiresAt: 0,
            lastOkAt: 0,
            lastError: "",
            updatedAt: keyRow.updatedAt,
          });
        }
        return out;
      }
      case "minimax-api": {
        // 开放平台的租户：每个租户一把 key。
        for (const t of miniMaxApiTenants(row.id)) {
          const keyId = miniMaxApiTenantSecretId(t.index, row.id);
          const keyRow = secretOf(keyId);
          out.push({
            id: keyId,
            accountId: row.id,
            upstreamId: row.id,
            kind: "api_key",
            label: `租户 ${t.index} 的 key`,
            masked: maskOf(t.key),
            fingerprint: fingerprintOf(t.key),
            status: CredentialState.USABLE,
            generation: 0,
            expiresAt: 0,
            lastOkAt: 0,
            lastError: "",
            updatedAt: keyRow.updatedAt,
          });
        }
        return out;
      }
      case "qoder":
      case "workbuddy":
      case "zcode": {
        const sessionId = `session:provider:${row.id}`;
        const session = secretOf(sessionId);
        out.push(sessionRow(sessionId, row.id, row.id, "登录会话", session.data, session.updatedAt));
        return out;
      }
      case "sensenova": {
        const sessionId = `session:provider:${row.id}`;
        const session = secretOf(sessionId);
        out.push(sessionRow(sessionId, row.id, row.id, "登录会话", session.data, session.updatedAt));
        const loginId = `key:provider:${row.id}:account`;
        const loginRow = secretOf(loginId);
        const login = loginRow.data;
        if (login?.user) {
          out.push({
            id: loginId,
            accountId: row.id,
            upstreamId: row.id,
            kind: "login",
            label: "登录账号",
            masked: maskOf(String(login.user)),
            fingerprint: fingerprintOf(String(login.user)),
            status: CredentialState.USABLE,
            generation: 0,
            expiresAt: 0,
            lastOkAt: 0,
            lastError: "",
            updatedAt: loginRow.updatedAt,
          });
        }
        // 推理用的 key：推理端点要的是它，不是 cookie。
        const apiKey = String(login?.apiKey ?? "");
        if (apiKey) {
          out.push({
            id: `${loginId}#api_key`,
            accountId: row.id,
            upstreamId: row.id,
            kind: "api_key",
            label: "推理 key",
            masked: maskOf(apiKey),
            fingerprint: fingerprintOf(apiKey),
            status: CredentialState.USABLE,
            generation: 0,
            expiresAt: 0,
            lastOkAt: 0,
            lastError: "",
            updatedAt: loginRow.updatedAt,
          });
        }
        return out;
      }
      case "intern-ai": {
        // 会话里是每个子站一份 token。
        const id = `session:provider:${row.id}`;
        const sessionRowData = secretOf(id);
        const session = sessionRowData.data;
        const sites = Array.isArray(session?.sites) ? session.sites : [];
        const token = String(sites[0]?.token ?? "");
        out.push({
          id,
          accountId: row.id,
          upstreamId: row.id,
          kind: "session",
          label: sites.length ? `子站 token（${sites.map((s: any) => s.name).join(" / ")}）` : "登录会话",
          masked: maskOf(token),
          fingerprint: fingerprintOf(token),
          status: token ? CredentialState.USABLE : CredentialState.MISSING,
          generation: 0,
          expiresAt: 0,
          lastOkAt: Number(session?.obtainedAtMs ?? 0),
          lastError: "",
          updatedAt: sessionRowData.updatedAt,
        });
        // 推理用的 key（Discovery 子站那把）：推理端点要的是它。
        const loginId = `key:provider:${row.id}:account`;
        const loginRow = secretOf(loginId);
        const login = loginRow.data;
        const discoveryKey = String(login?.discoveryKey ?? "");
        if (discoveryKey) {
          out.push({
            id: `${loginId}#discovery_key`,
            accountId: row.id,
            upstreamId: row.id,
            kind: "api_key",
            label: "推理 key（Discovery）",
            masked: maskOf(discoveryKey),
            fingerprint: fingerprintOf(discoveryKey),
            status: CredentialState.USABLE,
            generation: 0,
            expiresAt: 0,
            lastOkAt: 0,
            lastError: "",
            updatedAt: loginRow.updatedAt,
          });
        }
        return out;
      }
      case "tokenrhythm": {
        if (tenant === null) return out;
        const loginId = tokenRhythmTenantSecretId(tenant, row.id);
        const loginRow = secretOf(loginId);
        const login = loginRow.data;
        if (login) {
          out.push({
            id: loginId,
            accountId: accountId,
            upstreamId: row.id,
            kind: "login",
            label: "登录账号",
            masked: maskOf(String(login.account ?? "")),
            fingerprint: fingerprintOf(String(login.account ?? "")),
            status: login.account && login.password ? CredentialState.USABLE : CredentialState.MISSING,
            generation: 0,
            expiresAt: 0,
            lastOkAt: 0,
            lastError: "",
            updatedAt: loginRow.updatedAt,
          });
          const key = String(login.apiKey ?? "");
          if (key) {
            out.push({
              id: `${loginId}#api_key`,
              accountId,
              upstreamId: row.id,
              kind: "api_key",
              label: "推理 key",
              masked: maskOf(key),
              fingerprint: fingerprintOf(key),
              status: CredentialState.USABLE,
              generation: 0,
              expiresAt: 0,
              lastOkAt: 0,
              lastError: "",
              updatedAt: loginRow.updatedAt,
            });
          }
        }
        // 会话是一张表：上游自己的一张，按租户号存。这里按租户取它。
        const sessionId = `session:provider:${row.id}`;
        const table = getSecret<TokenRhythmTenantSessions>(sessionId);
        const raw = table?.[String(tenant)] ?? loadSession(tenant, row.id);
        out.push(sessionRow(`${sessionId}:tenant-${tenant}`, accountId, row.id, "会话 cookie", raw));
        return out;
      }
    }
  }
  return out;
}

/** 所有账号。TokenRhythm 的账号是租户，一个租户一个。 */
export function listAccounts(): AccountView[] {
  const out: AccountView[] = [];
  for (const row of listProviders()) {
    // The relay station has one account per tenant; the others have one.
    if (row.kind === "tokenrhythm") {
      for (const tenant of tokenRhythmTenants(row.id)) {
        const accountId = `${row.id}:${tenant.index}`;
        const credentials = credentialsOf(accountId);
        const session = credentials.find((c) => c.kind === "session");
        const usable = credentials.filter(
          (c) => c.status === CredentialState.USABLE || c.status === CredentialState.AUTHENTICATED,
        );
        out.push({
          id: accountId,
          upstreamId: row.id,
          label: `${row.alias} 租户 ${tenant.index}`,
          status: session ? session.status : usable.length ? CredentialState.USABLE : CredentialState.MISSING,
          credentialCount: credentials.length,
          detail: session
            ? `会话 ${credentialStateText(session.status)}`
            : usable.length
              ? "有可用的 key"
              : "暂无登录态",
        });
      }
      continue;
    }
    const credentials = credentialsOf(row.id);
    const sessions = credentials.filter((c) => c.kind === "session");
    const session = sessions[0];
    // 账号的状态：有一条能用的凭据就算登录了。
    //
    // 开放平台的凭据是租户的 key（不是会话），只认会话的话，那个账号明明有
    // 两把 key 却一直说「没有凭据」。
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
      upstreamId: row.id,
      label: row.alias,
      status,
      credentialCount: credentials.length,
      detail: session ? `会话 ${credentialStateText(session.status)}` : usable.length ? "有可用的 key" : "暂无凭据",
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

/* ------------------------------------------------------------------ *
 * 试一下 / 刷新一下
 * ------------------------------------------------------------------ */

/**
 * 一条凭据 id 指向的东西。
 *
 * 面板把凭据的 id 原样交回来，所以这里是唯一的算法：id 先读成「哪个上游、
 * 哪一种、哪个租户」，再按上游的种类决定怎么试。
 */
interface CredentialTarget {
  provider: ProviderRow;
  /** session / plan_key / api_key / login。 */
  form: string;
  /** 租户号（中转站与开放平台按租户分）。 */
  tenant: number | null;
  /** 从登录账号里派生出来的那把推理 key。 */
  derived: string;
}

/** 中转站的这个租户配了没有。 */
function tokenRhythmTenantOf(target: CredentialTarget) {
  if (target.tenant === null) return null;
  return tokenRhythmTenants(target.provider.id).find((t) => t.index === target.tenant) ?? null;
}

/**
 * 注销：把一个账号的凭据删掉。
 *
 * 账号的 id 是上游自己的 id，或者是「上游:租户号」那种（中转站一个租户一个
 * 账号）。凭据跟着账号走：租户账号只删它那一个租户的，会话与 key 一起删。
 */
export function logoutAccount(accountId: string): { ok: boolean; message: string; removed: number } {
  const id = String(accountId ?? "").trim();
  if (!id) return { ok: false, message: "要一个账号 id", removed: 0 };
  // 账号是「上游:租户号」的时候，凭据挂在那个上游下面、用租户号区分，
  // 所以按账号的 id 找得到。
  const { providerId, tenant } = splitAccountId(id);
  const row = provider(providerId);
  if (!row) return { ok: false, message: `没有这个账号：${id}`, removed: 0 };
  if (tenant === null) {
    const removed = deleteProviderCredentials(providerId);
    if (!removed) {
      return { ok: true, message: "这个账号本来就没有凭据", removed: 0 };
    }
    console.log(`[ADMIN] ${id} 注销了，删掉 ${removed} 条凭据`);
    return { ok: true, message: `注销了，删掉 ${removed} 条凭据`, removed };
  }
  const result = logoutTenant(providerId, tenant);
  if (!result.removed) {
    return { ok: true, message: "这个账号本来就没有凭据", removed: 0 };
  }
  console.log(`[ADMIN] ${id} 注销了，删掉 ${result.removed} 条凭据`);
  // 环境变量里配着的租户，删掉库里那份它就回来了 —— 说清楚，别让人以为
  // 注销干净了。
  const message = result.stillConfigured
    ? `注销了，删掉 ${result.removed} 条凭据；但这个租户仍由环境变量（TOKEN_RHYTHM_${tenant}_ACCOUNT）提供，账号会再出现`
    : `注销了，删掉 ${result.removed} 条凭据`;
  return { ok: true, message, removed: result.removed };
}

/**
 * 删掉中转站一个租户的凭据：账号那一份与它的会话。
 *
 * 会话是一张表（上游自己的一张，按租户号存），所以删的时候要把那一格摘掉，
 * 别把别的租户一起删了。
 *
 * 旧的那一份也要删：旧 id（account:tokenrhythm:<n>）只在内置的那个上游上
 * 存在，而读账号的那一步会回落读它 —— 不删它，「注销了」的租户下一次列账号
 * 就回来了。
 */
function logoutTenant(providerId: string, tenant: number): { removed: number; stillConfigured: boolean } {
  let removed = 0;
  const loginId = tokenRhythmTenantSecretId(tenant, providerId);
  if (getSecret(loginId)) {
    deleteSecret(loginId);
    removed++;
  }
  // 旧 id 只在内置的那个上游上存在（别的那几个的账号没有旧的一份）。
  if (providerId === TOKENRHYTHM_BUILT_IN) {
    const legacyId = `account:tokenrhythm:${tenant}`;
    if (getSecret(legacyId)) {
      deleteSecret(legacyId);
      removed++;
    }
  }
  const sessionId = `session:provider:${providerId}`;
  const table = getSecret<TokenRhythmTenantSessions>(sessionId);
  if (table && table[String(tenant)]) {
    forgetSession(tenant, providerId);
    removed++;
  }
  // 环境变量里配着的租户：环境优先于库里那份，所以它还在。
  // （只有内置的那个上游读环境变量。）
  const stillConfigured =
    providerId === TOKENRHYTHM_BUILT_IN && Boolean(readEnvValue(`TOKEN_RHYTHM_${tenant}_ACCOUNT`));
  return { removed, stillConfigured };
}

/** 试一条凭据还能不能用。 */
export async function testCredential(id: string): Promise<{ ok: boolean; message: string }> {
  const ref = parseCredentialId(id);
  if (!ref) return { ok: false, message: `不认识的凭据：${id}` };
  const row = provider(ref.providerId);
  if (!row) return { ok: false, message: `没有这个 Provider：${ref.providerId}` };
  const target: CredentialTarget = {
    provider: row,
    // 派生出来的推理 key 是从登录账号里取的那把：它算一把 key，不算账号。
    form: ref.derived ? "api_key" : ref.form,
    tenant: ref.tenant,
    derived: ref.derived,
  };
  try {
    return await testTarget(target);
  } catch (e) {
    return { ok: false, message: (e as Error)?.message ?? "试不了" };
  }
}

/**
 * 按上游的种类试一条凭据。
 *
 * 各家能问的东西不一样：有的问账号状态，有的问额度，有的问钱包。
 */
async function testTarget(target: CredentialTarget): Promise<{ ok: boolean; message: string }> {
  const p = target.provider;
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
      const cred = await readCredential(false, p.id);
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
      if (target.tenant === null) return { ok: false, message: "这条凭据没有租户号" };
      const tenant = miniMaxApiTenants(p.id).find((t) => t.index === target.tenant);
      return tenant
        ? { ok: true, message: `租户 ${tenant.index} 的 key 已配置` }
        : { ok: false, message: `没有租户 ${target.tenant} 的 key` };
    }
    case "tokenrhythm": {
      const tenant = tokenRhythmTenantOf(target);
      if (!tenant) {
        return {
          ok: false,
          message:
            target.tenant === null
              ? "这条凭据没有租户号"
              : `没有配置第 ${target.tenant} 个租户`,
        };
      }
      if (target.form === "api_key") {
        return tenant.apiKey
          ? { ok: true, message: `租户 ${tenant.index} 的推理 key 已配置` }
          : { ok: false, message: `租户 ${tenant.index} 没有推理 key` };
      }
      if (target.form === "login") {
        return tenant.account && tenant.password
          ? { ok: true, message: `租户 ${tenant.index} 的登录账号已配置` }
          : { ok: false, message: `租户 ${tenant.index} 的登录账号不完整` };
      }
      // 会话：先看有没有存着的会话（本地），有才去问平台。
      const session = loadSession(tenant.index, p.id);
      if (!session) return { ok: false, message: `租户 ${tenant.index} 没有登录态` };
      const w = await tokenRhythmWallet(session);
      return { ok: true, message: `能登录，可用余额 ${w.availableCny} ${w.currency}` };
    }
    default:
      return { ok: false, message: `这个上游不能试凭据：${p.id}` };
  }
}

/** 强制刷新一条凭据。 */
export async function refreshCredential(
  id: string,
): Promise<{ ok: boolean; message: string; generation: number }> {
  const ref = parseCredentialId(id);
  if (!ref) return { ok: false, message: `不认识的凭据：${id}`, generation: 0 };
  const row = provider(ref.providerId);
  if (!row) {
    return { ok: false, message: `没有这个 Provider：${ref.providerId}`, generation: 0 };
  }
  const target: CredentialTarget = {
    provider: row,
    form: ref.derived ? "api_key" : ref.form,
    tenant: ref.tenant,
    derived: ref.derived,
  };
  try {
    return await refreshTarget(target, id);
  } catch (e) {
    const err = e as { message?: string; hint?: string };
    return {
      ok: false,
      message: err?.hint ? `${err.message}：${err.hint}` : err?.message ?? "刷不了",
      generation: 0,
    };
  }
}

/** 按上游的种类刷新一条凭据。 */
async function refreshTarget(
  target: CredentialTarget,
  id: string,
): Promise<{ ok: boolean; message: string; generation: number }> {
  const p = target.provider;
  // 操作者主动点了「刷新一下」：就算平台刚才拒过，也再试一次。
  clearDeadSession(providerSecretId(p.id));
  switch (p.kind) {
    case "minimax": {
      // 会话由服务定时刷新（客户端就是这么干的），手动刷新没有意义；
      // 失效了的会话只能重新授权。
      const cred = await readCredential(false, p.id);
      if (cred.status !== "authenticated") {
        return { ok: false, message: "这份会话已经失效，需要重新登录（面板上登录一次）", generation: cred.generation };
      }
      return { ok: true, message: `会话由服务定时刷新（第 ${cred.generation} 代，还剩 ${Math.round(cred.remainingMs / 60000)} 分钟）`, generation: cred.generation };
    }
    case "qoder": {
      const session = await refreshQoderSession(false, p.id);
      return { ok: true, message: `会话由服务定时刷新（第 ${session.generation} 代）`, generation: session.generation };
    }
    case "workbuddy": {
      const session = await refreshWorkBuddySession(false, p.id);
      return { ok: true, message: `会话由服务定时刷新（第 ${session.generation} 代）`, generation: session.generation };
    }
    case "zcode":
      // ZCode 的令牌是 JWT，没有刷新通道：过期了只能重登。
      return { ok: false, message: "ZCode 的令牌没有刷新通道，过期了要重新登录", generation: 0 };
    case "tokenrhythm": {
      const tenant = tokenRhythmTenantOf(target);
      if (!tenant) {
        return {
          ok: false,
          message: target.tenant === null ? "这条凭据没有租户号" : `没有配置第 ${target.tenant} 个租户`,
          generation: 0,
        };
      }
      await loginTokenRhythm(tenant, p.id);
      return { ok: true, message: "重新登录完成", generation: 0 };
    }
    default:
      return { ok: false, message: `这条凭据不能刷新：${id}`, generation: 0 };
  }
}
