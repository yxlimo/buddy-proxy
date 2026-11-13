// lib/admin/accounts.ts — 账号与凭据：一家一行的账号，加上它名下的凭据。
//
// 账号就是 provider 表的一行（lib/providers.ts），凭据挂在它下面：secrets 表
// 里的 id 已经说明了它是谁的（session:provider:<账号>、key:provider:<账号>:<后缀>）。
// 这里把那些 id 读成一个面板能看的形状：这个账号手上有几条凭据，每条的状态如何。
//
// 敏感的值只写不读：列表里给的是掩码与指纹。

import crypto from "node:crypto";
import { deleteProviderCredentials, deleteProviderRow, listProviders, provider } from "../providers.ts";
import { getSecret } from "../store.ts";
import { clearDeadSession } from "../session.ts";
import { authLog, tokenFingerprint } from "../credential.ts";
import { dataDir } from "../paths.ts";
import { credentialsOfKind, kindOf, type CredentialSlot, type SlotReading } from "../provider-kinds.ts";
// The kinds register themselves; importing the file is what makes them known.
// 这一条 import 绕成 accounts → kinds → … → platform-state → accounts 的环，
// 所以环上的模块不能在求值期读别人的常量（这里读的都是函数，调用时才取值）。
import "../kinds/index.ts";
import { readCredential } from "../minimax/auth.ts";
import { loadSession as loadQoderSession } from "../qoder/auth.ts";
import { checkAccountHealth } from "../qoder/credits.ts";
import { loadSession as loadWorkBuddySession } from "../workbuddy/auth.ts";
import { fetchWorkBuddyCredits } from "../workbuddy/credits.ts";
import { zcodeStatus } from "../zcode/auth.ts";
import { clearOpenPlatformKey } from "../open-platform-credentials.ts";
import { quotaPluginOf } from "../quota-plugins.ts";
import { openPlatformOf } from "../open-platforms.ts";
import { fetchOpenPlatformModels } from "../open-platform-catalog.ts";
import { senseNovaInferenceKey } from "../sensenova/transport.ts";
import { internAiInferenceKey } from "../intern-ai/transport.ts";
import {
  forgetTokenRhythmCredential,
  loadSession as loadTokenRhythmSession,
  login as loginTokenRhythm,
  tokenRhythmCredentialOf,
} from "../tokenrhythm/accounts.ts";
import { wallet as tokenRhythmWallet } from "../tokenrhythm/wallet.ts";
import { forgetAccountSnapshot } from "./upstreams.ts";
import { clearCooldown } from "../cooldown.ts";
import { CredentialState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { credentialStateText, hasUsableCredential, openPlatformOfAccount, parseCredentialId } from "./credentials.ts";
import type { ProviderRow } from "../providers.ts";

/** 一个账号：provider 表的一行，也就是一份登录身份。 */
export interface AccountView {
  id: string;
  /** 它属于哪个平台：代码里的模板，或者表里的开放平台。 */
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
  /** session / api_key / cookie。 */
  kind: string;
  /**
   * 这条凭据能不能拿去推理。
   *
   * 有些平台配了两份：会话（问额度用）与 key（推理用）。只有推理的那一份
   * 是 true —— 别的配了也不算数，所以「这个账号能不能推理」按它判。
   */
  inference: boolean;
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
 * 这一条凭据能不能拿去推理。
 *
 * 判据只有一处：注册表说这一类上游的推理凭据是哪一份（inferWith），凭据的
 * 形态（session / api_key）说它自己是不是那一份。login 与 cookie 永远不是
 * —— 它们只是账号本身与查额度用的旁门。
 *
 * kind 没登记时一律 false：没有登记就没有这一类上游的规矩，猜不得（开放平台
 * 的 kind 登记了，所以它的账号有推理凭据：那一把 API key）。
 */
export function canInfer(kindName: string, form: string): boolean {
  const kind = kindOf(kindName);
  if (!kind) return false;
  if (form !== "session" && form !== "api_key") return false;
  return kind.inferWith === form;
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

/** 一条凭据读出来是什么状态：会话过没过期、平台拒过没有。 */
function statusOf(reading: SlotReading): CredentialState {
  if (!reading.present) return CredentialState.MISSING;
  // 平台拒过这份会话：它已经作废了，重新授权才有新的。
  if (reading.session?.refused) return CredentialState.EXPIRED;
  const expiresAt = reading.session?.expiresAt ?? 0;
  if (expiresAt > 0 && expiresAt <= Date.now()) return CredentialState.EXPIRED;
  return CredentialState.USABLE;
}

/** 声明里的一段读成面板上的一行。 */
function rowOf(account: ProviderRow, slot: CredentialSlot, reading: SlotReading): CredentialRow {
  return {
    id: reading.id,
    accountId: account.id,
    platform: account.platform,
    kind: slot.form,
    inference: canInfer(account.kind, slot.form),
    label: slot.label,
    masked: maskOf(reading.value),
    fingerprint: fingerprintOf(reading.value),
    status: statusOf(reading),
    generation: reading.session?.generation ?? 0,
    expiresAt: reading.session?.expiresAt ?? 0,
    lastOkAt: reading.session?.lastOkAt ?? 0,
    lastError: reading.session?.refused ? "这份会话已经失效，需要重新授权" : "",
    updatedAt: reading.updatedAt,
  };
}

/**
 * 一个账号的凭据。
 *
 * 形状由种类的声明说（lib/provider-kinds.ts 的 CredentialPlan）：这一段是会话、
 * 是推理 key、还是额度 cookie，叫什么名字，从哪儿读。这里只管遍历，不判哪一类
 * 是哪一类 —— 那种 switch 与面板、与写入那一头各写一份，三份迟早不一致（同一个
 * 平台可以有三四种叫法，就是这么来的）。
 *
 * 没配的那一段不列：面板上不能出现「有凭据」却没有凭据的行。例外是声明里写了
 * alwaysList 的那几段（面板要看得见「这段还没填」）。
 *
 * 账号的 id 就是 provider 表那一行的 id：先按 id 取行，行说它是哪个平台的。
 */
export function credentialsOf(accountId: string): CredentialRow[] {
  const out: CredentialRow[] = [];
  const account = provider(accountId);
  if (!account) return out;
  for (const slot of credentialsOfKind(account.kind).slots(account)) {
    const reading = slot.read(account);
    if (!reading.present && !slot.alwaysList) continue;
    out.push(rowOf(account, slot, reading));
  }
  return out;
}

/**
 * 这个账号的**全部**推理凭据。
 *
 * 与 inferenceCredentialOf 的区别：那个只给「现在能用」的那一条，这个给所有
 * 推理凭据 —— 判定要分得出「有凭据但过期了」与「压根没有凭据」：前者等人
 * 刷新或重新登录，后者要人去面板上填。
 */
export function inferenceCredentialsOf(accountId: string): CredentialRow[] {
  return credentialsOf(accountId).filter((row) => row.inference);
}

/**
 * 这个账号拿去推理的那一条凭据。
 *
 * 有些平台配了两份凭据：会话（问额度用）与 key（推理用）。只有推理的那一份
 * 算数 —— 别的配了也不算数，所以这里按 `inference` 挑，不按「有没有凭据」挑。
 *
 * 找不到就是 null：面板上要说「没有推理凭据」，路由也不该把它算成能接。
 */
export function inferenceCredentialOf(accountId: string): CredentialRow | null {
  for (const row of inferenceCredentialsOf(accountId)) {
    if (!hasUsableCredential(row.status)) continue;
    return row;
  }
  return null;
}

/**
 * 账号那一行的话：说的是**推理凭据**。
 *
 * 以前这里说的是「有可用的 key」—— 门户 cookie 与登录账号也算 key，于是七牛云
 * 只填了门户 cookie 时那一行说「有可用的 key」，与平台行、与路由都矛盾：那个
 * 账号一个请求也发不出去。
 */
function accountDetail(
  account: ProviderRow,
  credentials: CredentialRow[],
  inference: CredentialRow[],
  usable: CredentialRow | undefined,
): string {
  if (usable) {
    // 会话型平台的推理凭据就是登录会话。
    return usable.kind === "session" ? `会话 ${credentialStateText(usable.status)}` : "有可用的推理 Key";
  }
  // 有推理凭据但用不了：说得出是哪一条、什么状态。
  if (inference.length) return `${inference[0].label} ${credentialStateText(inference[0].status)}`;
  // 一点推理凭据都没有：说清是「只配了旁门的凭据」还是「什么都没配」。
  // 只算真的配上的那一条：额度插件的那一段没填时是 missing，拿它说「只有门户
  // cookie」就是拿没配的东西说配了。
  if (credentials.some((c) => c.kind === "cookie" && hasUsableCredential(c.status))) {
    return "没有推理用的凭据（只有额度 Cookie）";
  }
  // 会话型平台的推理凭据就是会话：那时候说的是「还没登录」。
  if (kindOf(account.kind)?.inferWith === "session") return "还没登录";
  return "还没配推理 Key";
}

/**
 * 所有账号：provider 表里的每一行。
 *
 * 以前中转站的账号是「上游:租户号」拼出来的，要在这里展开；现在一个账号就是
 * 一行，所以这里只读表。
 *
 * 逐个账号兜异常：凭据读不出来（secrets 表坏了）是网关自己的故障，不是「这个
 * 账号没有凭据」。一个账号读不出来不能让整页挂掉 —— 面板上那一个账号标成
 * 「读不出来」，别的账号照常列出来。判据与 lib/admin/platform-state.ts 一致
 * （那里把这种账号算 credential_unknown），错的事要落进 auth.log：凭据的毛病
 * 要留痕。
 */
export function listAccounts(): AccountView[] {
  const out: AccountView[] = [];
  for (const row of listProviders()) {
    let credentials: CredentialRow[];
    try {
      credentials = credentialsOf(row.id);
    } catch (e) {
      authLog(dataDir(), `读 ${row.id} 的凭据失败`, (e as Error)?.message ?? String(e ?? ""));
      out.push({
        id: row.id,
        platform: row.platform,
        alias: row.alias,
        // ERROR 是现有的枚举里说「这条凭据坏了」的那一档：读不出来不是「没有
        // 凭据」（那是 MISSING，说的是运维没配好），也不是「过期」。
        status: CredentialState.ERROR,
        // 数不出来：不是「这个账号一条凭据都没有」。
        credentialCount: 0,
        detail: "凭据读不出来：看日志",
        enabled: row.enabled,
        weight: row.weight,
        createdAt: row.createdAt,
      });
      continue;
    }
    // 账号的状态看**推理凭据**：配了门户 cookie 或登录账号不算「有凭据」，
    // 那些东西一个请求也发不出去。开放平台的凭据是 key（不是会话），所以看
    // 推理凭据而不是看会话 —— 那个账号明明有 key 却一直说「没有凭据」。
    const inference = credentials.filter((c) => c.inference);
    const usable = inference.find((c) => hasUsableCredential(c.status));
    const status = usable ? usable.status : inference.length ? inference[0].status : CredentialState.MISSING;
    out.push({
      id: row.id,
      platform: row.platform,
      alias: row.alias,
      status,
      credentialCount: credentials.length,
      detail: accountDetail(row, credentials, inference, usable),
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
  if (!id) return { ok: false, message: "需要提供账号 id", removed: 0 };
  const row = provider(id);
  if (!row) return { ok: false, message: `没有这个账号：${id}`, removed: 0 };
  const removed = forgetAccountRecords(id, row.kind);
  if (!removed) return { ok: true, message: "这个账号没有凭据", removed: 0 };
  console.log(`[ADMIN] ${id} 注销了，删掉 ${removed} 条凭据`);
  return { ok: true, message: `已注销，删除 ${removed} 条凭据`, removed };
}

/**
 * 一个账号的凭据，删干净。
 *
 * 两处都要删：账号自己名下那些、健康快照里它的那段。少删一处，那个账号就会
 * 带着旧身份回来 —— 快照里的额度会继续显示着一个已经不存在的账号。
 */
export function forgetAccountRecords(accountId: string, kind?: string): number {
  let removed = deleteProviderCredentials(accountId);
  // 开放平台的凭据自己清一遍：那把 key 是这个账号的全部身份，删账号就得删它
  // —— 不然它就成了一条没人认领的孤儿记录（存凭据的地方换了位置也不怕）。
  clearOpenPlatformKey(accountId);
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
  if (!id) return { ok: false, message: "需要提供账号 id", removed: 0 };
  const row = provider(id);
  if (!row) return { ok: false, message: `没有这个账号：${id}`, removed: 0 };
  const removed = forgetAccountRecords(id, row.kind);
  deleteProviderRow(id);
  console.log(`[ADMIN] ${id} 删了，连 ${removed} 条凭据一起`);
  return { ok: true, message: removed > 0 ? `已删除该账号及其 ${removed} 条凭据` : "已删除", removed };
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
  /** 面板交回来的那条 id：凭据行说它是推理那一段还是额度那一段。 */
  id: string;
  account: ProviderRow;
  /** session / api_key / login。 */
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
    return { ok: false, message: (e as Error)?.message ?? "无法测试这条凭据" };
  }
}

/** 凭据 id → 它指向的账号与形态。 */
function targetOf(id: string): { ok: true; value: CredentialTarget } | { ok: false; message: string } {
  const ref = parseCredentialId(id);
  if (!ref) return { ok: false, message: `无法识别的凭据：${id}` };
  const row = provider(ref.accountId);
  if (!row) return { ok: false, message: `没有这个账号：${ref.accountId}` };
  return {
    ok: true,
    value: {
      id,
      account: row,
      // 派生出来的那一条是从那一段凭据里取的：它算一条 key，不算账号。
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
      const cred = await readCredential(p.id);
      return {
        ok: true,
        message: `可用，第 ${cred.generation} 代，剩余 ${Math.round(cred.remainingMs / 60000)} 分钟`,
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
        ? { ok: true, message: `可用，今日已签到：${credits.checkedIn ? "是" : "否"}` }
        : { ok: false, message: "无法读取签到状态" };
    }
    case "zcode": {
      // ZCode 的令牌没有刷新通道，过期了只能重登，所以这里只能看它还在不在。
      const status = zcodeStatus(p.id);
      const state = String(status.status ?? "");
      if (state === "authenticated") return { ok: true, message: "可用" };
      if (state === "expired") return { ok: false, message: "令牌已过期，需要重新登录" };
      return { ok: false, message: "未登录 ZCode" };
    }
    case "sensenova": {
      // 会话与推理 key 是两回事：会话说的是登录态，推理 key 说的是干活的那把
      // 钥匙。
      if (target.form === "session") {
        const session = getSecret<{ accessToken?: string }>(`session:provider:${p.id}`);
        return session?.accessToken
          ? { ok: true, message: "登录会话仍然有效" }
          : { ok: false, message: "没有登录会话" };
      }
      const key = senseNovaInferenceKey(p.id);
      return key
        ? { ok: true, message: "推理 Key 已配置" }
        : { ok: false, message: "未配置推理 Key" };
    }
    case "intern-ai": {
      if (target.form === "session") {
        const session = getSecret<{ token?: string }>(`session:provider:${p.id}`);
        return session?.token
          ? { ok: true, message: "登录会话仍然有效" }
          : { ok: false, message: "没有登录会话" };
      }
      const key = internAiInferenceKey(p.id);
      return key
        ? { ok: true, message: "推理 Key 已配置" }
        : { ok: false, message: "未配置推理 Key" };
    }
    case "tokenrhythm": {
      const credential = tokenRhythmCredentialOf(p.id);
      if (!credential) return { ok: false, message: "这个账号未配置凭据" };
      if (target.form === "api_key") {
        return credential.apiKey
          ? { ok: true, message: "推理 Key 已配置" }
          : { ok: false, message: "未配置推理 Key" };
      }
      if (target.form !== "session") return { ok: false, message: `不知道这条凭据的形态：${target.form}` };
      // 会话：先看有没有存着的会话（本地），有才去问平台。
      const session = loadTokenRhythmSession(p.id);
      if (!session) return { ok: false, message: "这个账号没有登录态" };
      const w = await tokenRhythmWallet(session);
      return { ok: true, message: `可以登录，可用余额 ${w.availableCny} ${w.currency}` };
    }
    // 一把推理 key 加额度那几段的平台（七牛云、讯飞星火）与通用开放平台
    // （openai / anthropic）走同一个测试：它们的凭据形状是一样的。
    case "qiniu":
    case "xinghuo":
      return testKeyOrQuotaCredential(p, target.id);
    default: {
      if (openPlatformOfAccount(p.id)) return testKeyOrQuotaCredential(p, target.id);
      return { ok: false, message: `这个账号不支持测试凭据：${p.id}` };
    }
  }
}

/**
 * 一把推理 key 加额度那几段的平台怎么试。
 *
 * 两段的试法不一样：推理 key 拿去问上游要模型清单（那是同一份鉴权，上游收下
 * 这个 key 才答得出清单），额度那一段交给平台的额度插件问一次 —— 门户 cookie
 * 只有那个接口认。不按 id 的后缀猜是那一段：两段共用一个存储位置的平台（七牛
 * 云）后缀分不出来，凭据行上的 inference 才是唯一判据。
 */
async function testKeyOrQuotaCredential(
  account: ProviderRow,
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const row = credentialsOf(account.id).find((c) => c.id === id);
  if (!row) return { ok: false, message: `没有这条凭据：${id}` };
  if (row.inference) return testInferenceKey(account);
  return testQuotaCredential(account);
}

/** 推理那段：问一次上游的模型清单。 */
async function testInferenceKey(account: ProviderRow): Promise<{ ok: boolean; message: string }> {
  const key = String(kindOf(account.kind)?.keyOf?.(account, account.id) ?? "").trim();
  if (!key) return { ok: false, message: "未配置推理 Key" };
  const platform = openPlatformOf(account.platform);
  if (!platform || !String(platform.baseUrl ?? "").trim()) {
    // 没地址可问（平台行没填）：key 在不在就是能确认的全部。
    return { ok: true, message: "推理 Key 已配置（这个平台没有地址，问不到上游）" };
  }
  const models = await fetchOpenPlatformModels(platform, key);
  return models
    ? { ok: true, message: `可用，上游答了 ${models.length} 个模型` }
    : {
        ok: false,
        message: "上游没有答模型清单：key 可能不对，也可能是这个平台没有 /models（细节看日志）",
      };
}

/** 额度那段：交给平台的额度插件问一次（插件不 reject，答不出来就是 unknown）。 */
async function testQuotaCredential(account: ProviderRow): Promise<{ ok: boolean; message: string }> {
  const plugin = quotaPluginOf(openPlatformOf(account.platform)?.quotaPlugin?.trim() ?? "");
  if (!plugin) return { ok: false, message: "这个平台没有额度插件，这段凭据没有可以问的接口" };
  const probe = await plugin.probe(account);
  if (probe.state === "ok") return { ok: true, message: probe.message ? `可用，${probe.message}` : "可用" };
  return { ok: false, message: probe.message || `额度接口没答上来（${probe.state}）` };
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
      message: err?.hint ? `${err.message}：${err.hint}` : err?.message ?? "无法刷新这条凭据",
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
        return { ok: false, message: "这份会话已失效，需要重新登录（在面板上登录一次）", generation: cred.generation };
      }
      return { ok: true, message: `会话由服务定时刷新（第 ${cred.generation} 代，剩余 ${Math.round(cred.remainingMs / 60000)} 分钟）`, generation: cred.generation };
    }
    case "qoder": {
      // 只读现在这一份：换令牌是定时器的事，这里换了就跟定时器撞上了。
      const session = loadQoderSession(p.id);
      if (!session) return { ok: false, message: "未登录，请在面板上登录一次", generation: 0 };
      return { ok: true, message: `会话由服务定时刷新（第 ${session.generation} 代）`, generation: session.generation };
    }
    case "workbuddy": {
      const session = loadWorkBuddySession(p.id);
      if (!session) return { ok: false, message: "未登录，请在面板上登录一次", generation: 0 };
      return { ok: true, message: `会话由服务定时刷新（第 ${session.generation} 代）`, generation: session.generation };
    }
    case "zcode":
      // ZCode 的令牌是 JWT，没有刷新通道：过期了只能重登。
      return { ok: false, message: "ZCode 的令牌没有刷新通道，过期后需要重新登录", generation: 0 };
    case "tokenrhythm": {
      await loginTokenRhythm(p.id);
      return { ok: true, message: "重新登录已完成", generation: 0 };
    }
    default:
      return { ok: false, message: `这条凭据不支持刷新：${id}`, generation: 0 };
  }
}
