// lib/admin/upstreams.ts — 上游的共同视图。
//
// /health 与管理面板问的是同一批东西：哪个上游开着、它现在公布多少模型、
// 凭据是什么状态、账号上还剩多少。这个模块是唯一知道怎么去问的地方，
// 两边共用，免得各问各的、答得不一样。
//
// 开关在数据库的 provider.enabled 上，每次现读：面板改了，下一个请求就是新的
// —— 不用重启，也不用重新读配置。

import { configNumber, configString } from "../config.ts";
import { MINIMAX_MODELS, type MiniMaxModel } from "../minimax/models.ts";
import { miniMaxApiTenantPlans } from "../minimax/api.ts";
import { zcodeQuota } from "../zcode/credits.ts";
import { readCredential } from "../minimax/auth.ts";
import { fetchMiniMaxBalance, miniMaxTokenPlan, fetchMiniMaxTokenPlanWithSession } from "../minimax/credits.ts";
import { fetchMiniMaxCredits } from "../minimax/checkin.ts";
import { qoderModelsForRegion, type QoderModel } from "../qoder/models.ts";
import { type QoderRegion } from "../qoder/auth.ts";
import { checkAccountHealth, fetchQoderCredits } from "../qoder/credits.ts";
import { fetchWorkBuddyCredits } from "../workbuddy/credits.ts";
import {
  setWorkbuddyModelList,
  workbuddyModelList,
  type WorkBuddyModel,
} from "../workbuddy/models.ts";
import { tokenRhythmStatuses } from "../tokenrhythm/wallet.ts";
import { loadSession as loadSenseNovaSession } from "../sensenova/auth.ts";
import { poolUsage as senseNovaPoolUsage } from "../sensenova/quota.ts";
import { loadSession as loadInternAiSession, tokenFor as internAiTokenFor } from "../intern-ai/auth.ts";
import { balance as internAiBalance, creditPacks as internAiCreditPacks } from "../intern-ai/quota.ts";
import { peekCached, setCached } from "../store.ts";
import { HEALTH_CACHE_ID } from "../health-cache.ts";
import {
  accountsOfPlatform,
  listProviders,
  policyOf,
  provider,
  setProviderEnabled,
} from "../providers.ts";
import { isPlatform, platformOf } from "../platforms.ts";
// The kinds register themselves; importing the file is what makes them known.
import "../kinds.ts";
import { kindOf } from "../provider-kinds.ts";
import type { ProviderRow } from "../providers.ts";
import type {
  BalanceView,
  CreditView,
  CredentialView,
  HealthSnapshot,
  QuotaView,
  TokenPlanView,
} from "../provider-kinds.ts";

// The panel's own view of these shapes comes from here.
export type { BalanceView, CreditView, CredentialView, HealthSnapshot, QuotaView, TokenPlanView };
import { CredentialState, ProviderPolicy as ContractPolicy, UpstreamState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { hasUsableCredential } from "./credentials.ts";
import { loginActivity } from "./login.ts";
import { policyEnum } from "./policy.ts";
import { type CatalogGroup } from "../router/catalog.ts";

/** 上游的 id。现在有两种：平台 id（面板上的那一行），与账号行的 id。 */
/** A provider's id. The kind is not part of it: the table has the kind. */
export type UpstreamId = string;

/**
 * 这个 id 名下的账号行。
 *
 * 面板问的是**平台**（一行九个服务之一），适配器手里是**账号**（一行一份
 * 登录）。两种 id 都收：认得出来的平台就取它名下的账号，否则就当账号 id。
 *
 * 先认平台：账号 id 是从平台 id 起的（`minimax`、`minimax-2`），所以一个平台
 * 的第一个账号与平台同名 —— 先认平台才看得见同名的其他账号。
 */
function accountsFor(id: string): ProviderRow[] {
  if (isPlatform(id)) return accountsOfPlatform(id);
  const row = provider(id);
  return row ? [row] : [];
}

/**
 * 这个平台现在能不能接：它名下有没有开着的账号。
 *
 * 平台自己没有开关 —— 开关在账号上，一个平台下有两个账号时可以只开一个。
 * 传账号 id 时问的就是那一个账号。
 */
export function upstreamEnabled(id: string): boolean {
  return accountsFor(id).some((row) => row.enabled);
}

/** 一个上游的开关状态。 */
export interface UpstreamSwitch {
  /** 现在在生效的值。开关是热的：面板改了，下一个请求就是新的。 */
  enabled: boolean;
}

/**
 * 打开或关掉一个账号。
 *
 * 开关在数据库的 provider.enabled 上，每次现读：写进去，下一个请求就是新的。
 */
export function setAccountEnabled(id: string, enabled: boolean): { ok: boolean; message: string } {
  const result = setProviderEnabled(id, enabled);
  if (!result.ok) return result;
  const row = provider(id);
  return {
    ok: true,
    message: `${row?.alias || id} ${enabled ? "开着" : "关了"}，已经生效`,
  };
}

/**
 * 一个平台的地址。
 *
 * 面板上要看得见网关到底在跟谁说话：这个平台的基础地址。地址是平台的事，所以
 * 拿它名下随便哪个账号去问都是同一个（账号只是登录身份）。
 */
export function upstreamBaseUrl(id: string): string {
  const row = accountsFor(id)[0];
  const kind = row ? kindOf(row.kind) : null;
  return kind && row ? kind.baseUrl(row) : "";
}

/**
 * 这个平台的生效策略。
 *
 * 策略在平台层：它说的是「这个平台下的几个账号怎么选」，而一个账号自己没法
 * 决定要不要退到另一个账号。
 */
export function upstreamPolicy(id: string): ContractPolicy {
  return policyEnum(policyOf(id));
}

/**
 * 这个平台名下有几个账号。
 *
 * 数的是 provider 表的行 —— 账号模型里一行就是一个登录，所以这里不按平台自己
 * 的名单去数（那样同一个平台下的两个账号会被数成一个）。
 */
export function upstreamAccountCount(id: string): number {
  return accountsFor(id).length;
}

/**
 * 平台的区域。
 *
 * cn / global 是契约里写的两个。TokenRhythm、SenseNova 与书生·端砚没有区域
 * 之分（就一个站点）。
 */
export function upstreamRegion(id: string): string {
  return platformOf(id)?.region ?? provider(id)?.region ?? "";
}

/* ------------------------------------------------------------------ *
 * 模型目录
 * ------------------------------------------------------------------ */

/** MiniMax 公布的模型。上游关着就一个也不公布。 */
export function minimaxVisible(): MiniMaxModel[] {
  return upstreamEnabled("minimax") ? MINIMAX_MODELS : [];
}

/** Qoder 全球区与中国区各自能服务的模型。 */
export function qoderVisible(region: QoderRegion): QoderModel[] {
  const id: UpstreamId = region === "cn" ? "qoder-cn" : "qoder";
  return upstreamEnabled(id) ? qoderModelsForRegion(region) : [];
}

/**
 * WorkBuddy 的模型目录。
 *
 * 上游自己发布的目录才是准的（它不发客户端版本就换模型），快照只是兜底。
 * 目录住在 lib/workbuddy/models.ts —— 刷新它的东西也住在那里，注册表与路由
 * 读的是同一份，不会出现「面板看见的」与「路由得到的」两份目录。
 */
/** WorkBuddy 现在的模型目录。 */
export function workbuddyCatalog(): WorkBuddyModel[] {
  return workbuddyModelList();
}

/** 换掉 WorkBuddy 的模型目录（上游刷新之后）。 */
export function setWorkbuddyCatalog(models: WorkBuddyModel[]): void {
  setWorkbuddyModelList(models);
}

/** 现在开着的 Qoder 区域。 */
export function qoderRegions(): QoderRegion[] {
  return [
    ...(upstreamEnabled("qoder") ? (["global"] as QoderRegion[]) : []),
    ...(upstreamEnabled("qoder-cn") ? (["cn"] as QoderRegion[]) : []),
  ];
}

/**
 * 每个平台的模型目录，面板与 /v1/models 共用。
 *
 * 一组一个**平台**：路径里那一段是平台 id，同一个平台下有两个账号也只有一组
 * 目录 —— 按账号分组会把同一批模型公布两遍。目录本身是平台的 kind 说的，跟
 * 是哪个账号无关。
 *
 * 只收有开着账号的平台：一个关着的上游不公布模型，请求它的时候也给一句清楚
 * 的「没启用」，而不是把它丢给一个不会回答的上游。
 */
export function catalogGroups(): CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  const seen = new Set<string>();
  for (const row of listProviders()) {
    if (!row.enabled) continue;
    if (seen.has(row.platform)) continue;
    const kind = kindOf(row.kind);
    if (!kind) continue;
    const models = kind.models(row);
    if (!models.length) continue;
    seen.add(row.platform);
    groups.push({ group: row.platform, models });
  }
  return groups;
}

/** 一个平台现在公布几个模型。 */
export function upstreamModelCount(id: string): number {
  const row = accountsFor(id)[0];
  const kind = row ? kindOf(row.kind) : null;
  if (!row || !kind) return 0;
  return kind.models(row).length;
}

/* ------------------------------------------------------------------ *
 * /health 的快照
 * ------------------------------------------------------------------ */

/**
 * /health 里问上游的那些东西。
 *
 * 问上游是慢的那一半（十几个请求、五个平台），所以答案放在数据库里，后台
 * 按时刷新。端点回答的是最后已知的状态 —— 健康检查要的也正是这个。
 */

/**
 * The health snapshot's cache.
 *
 * The version is part of the key: the snapshot's shape changed when the
 * upstreams arrived (each upstream has its own numbers now), and an old
 * snapshot read as a new one would say the wrong thing.
 *
 * The id lives in lib/health-cache.ts: the routing layer reads the snapshot
 * too (a plan window says when a rate limit resets), and it should not have to
 * pull this whole module in for one string.
 */
/** 快照最多放多久。 */
export const HEALTH_CACHE_MS = configNumber("HEALTH_CACHE_MS", 300_000);

/** 两次刷新之间至少隔多久，免得面板把上游问烦了。 */
const FRESH_MIN_MS = 5_000;

let healthRefresh: Promise<void> | null = null;
let healthRefreshedAt = 0;

/** MiniMax 的区域。 */
const MINIMAX_REGION = configString("MINIMAX_REGION", "cn");

/**
 * MiniMax 账号上的余额。
 *
 * 路由器握着他的会话，所以只有路由器能问平台。
 */
export async function miniMaxBalance(providerId = "minimax"): Promise<unknown> {
  try {
    const cred = await readCredential(providerId);
    return await fetchMiniMaxBalance(cred.accessToken, MINIMAX_REGION === "en" ? "global" : "cn");
  } catch {
    return null;
  }
}

/**
 * MiniMax Code 账号上的积分。
 *
 * 账户余额（query_balance）说的是平台上的钱，Code 账号上是零；签到给的是
 * 积分，在积分明细里。
 */
export async function miniMaxCredits(providerId = "minimax"): Promise<unknown> {
  try {
    const cred = await readCredential(providerId);
    return await fetchMiniMaxCredits(cred.accessToken, "", MINIMAX_REGION === "en" ? "global" : "cn");
  } catch {
    return null;
  }
}

/**
 * MiniMax Code 账号上的套餐额度。
 *
 * 先用会话读：会话是账号自己登录用的，每个账号都有，桌面客户端就是这么读的
 * （`/backend/account/token_plan/remains_percent`）。读不到再退回 plan key 那条
 * （开放平台的 `/v1/token_plan/remains`，要 sk-cp- 那种 key）。
 */
export async function miniMaxCodeTokenPlan(providerId = "minimax"): Promise<unknown> {
  const region = MINIMAX_REGION === "en" ? "global" : "cn";
  try {
    const cred = await readCredential(providerId);
    const withSession = await fetchMiniMaxTokenPlanWithSession(cred.accessToken, region);
    if (withSession?.windows.length) return withSession;
  } catch {
    // 没有会话或读不到，往下走。
  }
  return miniMaxTokenPlan(300_000, providerId);
}

/**
 * SenseNova 的积分池。
 *
 * 问的是控制台（要登录态），没登录就问不了 —— 那是「不知道」，不是「没有」。
 */
async function senseNovaPools(providerId = "sensenova"): Promise<unknown> {
  const session = loadSenseNovaSession(providerId);
  if (!session) return null;
  try {
    return await senseNovaPoolUsage(session);
  } catch (e) {
    console.warn(`[SENSENOVA] 积分池查询失败：${(e as Error)?.message}`);
    return null;
  }
}

/**
 * 书生·端砚的墨点：余额与批次。
 *
 * 两个接口都要登录态（Discovery 子站的 token）。批次拿不到时余额照样报 ——
 * 余额才是那个最要紧的数。
 */
async function internAiCredits(providerId = "intern-ai"): Promise<{ balance: unknown; packs: unknown }> {
  const session = loadInternAiSession(providerId);
  if (!session) return { balance: null, packs: null };
  const token = internAiTokenFor(session, "discovery");
  if (!token) return { balance: null, packs: null };
  try {
    const balance = await internAiBalance(session, token);
    let packs: unknown = null;
    try {
      packs = await internAiCreditPacks(session, token);
    } catch (e) {
      console.warn(`[INTERN-AI] 墨点批次查询失败：${(e as Error)?.message}`);
    }
    return { balance, packs };
  } catch (e) {
    console.warn(`[INTERN-AI] 墨点余额查询失败：${(e as Error)?.message}`);
    return { balance: null, packs: null };
  }
}

/**
 * 问一遍上游，把答案记下来。
 *
 * 每家按上游分开记：两个同类的上游各有各的数字。
 */
export async function refreshHealthSnapshot(): Promise<void> {
  const snapshot: HealthSnapshot = {
    qoder: {},
    minimax: {},
    minimaxApi: {},
    zcode: {},
    workbuddy: {},
    tokenrhythm: {},
    sensenova: {},
    internAi: {},
  };

  for (const row of listProviders()) {
    switch (row.kind) {
      case "qoder": {
        let account: unknown;
        try {
          account = await checkAccountHealth(row.id);
        } catch (e) {
          account = { region: row.region, usable: false, reason: (e as Error)?.message };
        }
        snapshot.qoder[row.id] = { account, credits: await fetchQoderCredits(row.id) };
        break;
      }
      case "minimax":
        snapshot.minimax[row.id] = {
          balance: await miniMaxBalance(row.id),
          tokenPlan: await miniMaxCodeTokenPlan(row.id),
          credits: await miniMaxCredits(row.id),
        };
        break;
      case "minimax-api":
        snapshot.minimaxApi[row.id] = { tenants: await miniMaxApiTenantPlans(row.id) };
        break;
      case "zcode":
        snapshot.zcode[row.id] = { quota: await zcodeQuota(300_000, row.id) };
        break;
      case "workbuddy":
        snapshot.workbuddy[row.id] = { credits: await fetchWorkBuddyCredits(row.id) };
        break;
      case "tokenrhythm":
        // 一个账号一行一个钱包：快照也按账号存。
        snapshot.tokenrhythm[row.id] = { tenants: await tokenRhythmStatuses(row.id) };
        break;
      case "sensenova":
        snapshot.sensenova[row.id] = { pools: await senseNovaPools(row.id) };
        break;
      case "intern-ai":
        snapshot.internAi[row.id] = await internAiCredits(row.id);
        break;
    }
  }
  setCached(HEALTH_CACHE_ID, snapshot);
  healthRefreshedAt = Date.now();
}

/**
 * 快照，以及一次后台刷新。
 *
 * 快照旧了就起一个刷新（不等它），端点立刻拿旧答案走 —— 健康检查不该被
 * 上游的慢拖住。
 */
export function healthSnapshot(): { data: HealthSnapshot | null; at: number; stale: boolean } {
  const cached = peekCached<HealthSnapshot>(HEALTH_CACHE_ID);
  const at = cached?.at ?? 0;
  const stale = !cached || Date.now() - at > HEALTH_CACHE_MS;
  if (stale && !healthRefresh) {
    healthRefresh = refreshHealthSnapshot()
      .catch((e) => console.warn(`[HEALTH] 刷新失败：${(e as Error)?.message}`))
      .finally(() => {
        healthRefresh = null;
      });
  }
  return { data: cached?.data ?? null, at, stale };
}

/** 快照是不是正在刷新。 */
export function healthRefreshing(): boolean {
  return healthRefresh !== null;
}

/**
 * 让快照是最新的，面板要现数的时候用。
 *
 * 刚刷过就不再来一次，免得面板一打开就把上游问一轮。
 */
export async function freshHealthSnapshot(): Promise<HealthSnapshot> {
  if (Date.now() - healthRefreshedAt > FRESH_MIN_MS) {
    try {
      await refreshHealthSnapshot();
    } catch (e) {
      console.warn(`[HEALTH] 刷新失败：${(e as Error)?.message}`);
    }
  }
  return peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? ({} as HealthSnapshot);
}

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/**
 * 一个平台的凭据状态。
 *
 * 凭据在账号上，所以平台报的是它名下那些账号里最好的那一份：有能用的就说
 * 能用，全都没有才说没有。要逐个看的话在账号列表里（ListAccounts）。
 *
 * 各家上游的会话形状不一样，但状态字段是同一套，所以这里把它们抹平。
 */
export function upstreamCredential(id: string): CredentialView {
  const rows = accountsFor(id);
  // 一份坏掉的会话不该把整个面板打成 500：读不出来的那一条当作没有凭据。
  const views = rows.flatMap((row) => {
    const view = safeCredential(row);
    return view ? [view] : [];
  });
  const pick = views.find((view) => hasUsableCredential(view.status)) ?? views[0];
  if (!pick) {
    return {
      kind: "session",
      status: CredentialState.MISSING,
      fingerprint: "",
      expiresAt: 0,
      remainingSec: 0,
      warning: false,
      detail: "这个平台还没有账号",
      generation: 0,
    };
  }
  return pick;
}

/** 一个账号的凭据状态。会话坏了就是读不出来，不抛。 */
function safeCredential(row: ProviderRow): CredentialView | null {
  const kind = kindOf(row.kind);
  if (!kind) return null;
  try {
    return kind.credential(row);
  } catch (e) {
    console.warn(`[ADMIN] 账号 ${row.id} 的凭据状态读不出来：${(e as Error)?.message}`);
    return {
      kind: "session",
      status: CredentialState.ERROR,
      fingerprint: "",
      expiresAt: 0,
      remainingSec: 0,
      warning: false,
      detail: "凭据状态读不出来，重新登录一次",
      generation: 0,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 余额
 * ------------------------------------------------------------------ */

/**
 * 一个账号的额度。
 *
 * 三样东西各是各的，**不能相加**：余额（钱）、积分（点数）、套餐额度
 * （按窗口的百分比）。后端把能拿到的都放上来，前端按有哪个显示哪个。
 *
 * 哪一样是哪个，由 kind 注册表说（lib/kinds.ts）。
 */

/**
 * 一个上游的额度，每个账号一条。
 *
 * TokenRhythm 有好几个租户，所以是「几条」而不是一条。
 *
 * `fresh` 的时候先问一遍平台：面板要看现数时才用，不然就用缓存里的。
 */
export async function upstreamQuotas(id: string, fresh = false): Promise<QuotaView[]> {
  const rows = accountsFor(id);
  if (!rows.length) return [];
  const snapshot = fresh
    ? await freshHealthSnapshot()
    : peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? null;
  if (!snapshot) return [];
  const out: QuotaView[] = [];
  for (const row of rows) {
    const kind = kindOf(row.kind);
    if (!kind) continue;
    out.push(...kind.quotas(row, snapshot));
  }
  return out;
}

/**
 * 一个上游的额度，合并成一条。
 *
 * 同一个平台的多个账号可以合并（TokenRhythm 的三个租户）。合并的是同一类
 * 东西 —— 余额跟余额加，积分跟积分加，不同类的还是不碰。
 */
export function mergeQuotas(quotas: QuotaView[]): QuotaView | null {
  if (!quotas.length) return null;
  const first = quotas[0];
  const balances = quotas.map((q) => q.balance).filter((b): b is BalanceView => Boolean(b));
  const credits = quotas.map((q) => q.credits).filter((c): c is CreditView => Boolean(c));
  const merged: QuotaView = {
    upstreamId: first.upstreamId,
    accountId: first.accountId,
    tokenPlan: quotas.find((q) => q.tokenPlan)?.tokenPlan,
  };
  if (balances.length) {
    merged.balance = {
      availableCny: balances.reduce((sum, b) => sum + b.availableCny, 0),
      currency: balances[0].currency,
      lots: balances.flatMap((b) => b.lots),
      // 最早到期的那一批。
      nextExpiryAt: balances.reduce((min, b) => (b.nextExpiryAt && (!min || b.nextExpiryAt < min) ? b.nextExpiryAt : min), 0),
      expiringCny: balances.reduce((sum, b) => sum + b.expiringCny, 0),
    };
  }
  if (credits.length) {
    merged.credits = {
      total: credits.reduce((sum, c) => sum + c.total, 0),
      used: credits.reduce((sum, c) => sum + c.used, 0),
      remaining: credits.reduce((sum, c) => sum + c.remaining, 0),
      lots: credits.flatMap((c) => c.lots),
      note: credits[0].note,
    };
  }
  return merged;
}

/**
 * 忘掉一个账号在健康快照里的那一段。
 *
 * 账号删掉了，快照里还留着它的余额与套餐：那是它的痕迹。删干净了，系统里
 * 就不该再有关于它的话。
 */
export function forgetAccountSnapshot(accountId: string): void {
  const snapshot = peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data;
  if (!snapshot) return;
  let changed = false;
  // 快照的每个桶都是「账号 id → 那一份」。摊成一张表就能按账号 id 找。
  const buckets: Record<string, unknown> = { ...snapshot };
  for (const bucket of Object.values(buckets)) {
    if (!bucket || typeof bucket !== "object") continue;
    const table = bucket as Record<string, unknown>;
    if (!(accountId in table)) continue;
    delete table[accountId];
    changed = true;
  }
  if (changed) setCached(HEALTH_CACHE_ID, snapshot);
}

/** 一个上游的额度，合并成一条。上游列表用它。 */
export function upstreamQuota(id: UpstreamId): QuotaView | null {
  return mergeQuotas(upstreamQuotasCached(id));
}

/**
 * 快照里一个 Provider 的那一份。
 *
 * 快照是**按上游 id** 存的（provider.minimax、provider.qoder-cn……），
 * 所以按 kind 去取会取到 undefined —— 面板上的余额、套餐额度、租户就全是
 * null，而数据其实就在旁边。
 */
export function snapshotEntry(
  snapshot: HealthSnapshot | null,
  kind: string,
  providerId: string,
): any {
  if (!snapshot) return null;
  const bucket = (snapshot as any)[kind];
  if (!bucket) return null;
  return bucket[providerId] ?? null;
}

/** 从快照里取一个 Provider 的额度，不问上游。 */
function upstreamQuotasCached(id: string): QuotaView[] {
  const snapshot = peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? null;
  if (!snapshot) return [];
  const out: QuotaView[] = [];
  for (const row of accountsFor(id)) {
    const kind = kindOf(row.kind);
    if (!kind) continue;
    out.push(...kind.quotas(row, snapshot));
  }
  return out;
}


/**
 * MiniMax 的套餐额度。
 *
 * 就是 lib/kinds.ts 里那一份（视频窗口在那里被排掉）。这里只做转出，不再留一份
 * 副本 —— 两份实现迟早会走样。
 */
export { tokenPlanView } from "../kinds.ts";

/* ------------------------------------------------------------------ *
 * 上游现在能不能接
 * ------------------------------------------------------------------ */

/**
 * 这个上游的额度用尽了吗？
 *
 * 判据（都用 /health 的缓存，不去打上游）：
 *
 *   minimax      账户余额 ≤ 0。钱、券、赠金都算在 available 里。
 *   qoder        套餐额度用尽。**加购的那一池不算数** —— 上游在套餐用尽时
 *                会把活动藏起来（之前踩过这个坑），所以套餐这一池才是要紧
 *                的；两池都空当然也是用尽。
 *   workbuddy    今天的签到积分没了。
 *   tokenrhythm  钱包里没钱了。
 *   sensenova    每个能服务模型的积分池都空了。
 *   intern-ai    墨点余额没了，或者 5 小时 / 7 天的窗口用满了。
 *
 * 读不到数据就说「不知道」：null 不算用尽。
 */
export function outOfCredits(id: string): boolean {
  const rows = accountsFor(id).filter((row) => row.enabled);
  const snapshot = peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? null;
  if (!snapshot || !rows.length) return false;
  // 一个平台名下有几个账号：只要有一个还有钱，这个平台就还没用完。
  return rows.every((row) => {
    const kind = kindOf(row.kind);
    return kind ? kind.outOfCredits(row, snapshot) : false;
  });
}

/** 一个账号自己的状态（不看别的账号）。 */
function accountState(row: ProviderRow): UpstreamState {
  if (!row.enabled) return UpstreamState.DISABLED;
  const activity = loginActivity(row.id);
  if (activity.loggingIn) return UpstreamState.LOGGING_IN;
  const credential = safeCredential(row);
  if (!credential) return UpstreamState.NO_CREDENTIAL;
  if (credential.status === CredentialState.ERROR) return UpstreamState.CREDENTIAL_REJECTED;
  if (!hasUsableCredential(credential.status)) {
    // 登录被拒过：面板上要说的是「被拒了」—— 用户能照着改密码。
    if (activity.rejected) return UpstreamState.CREDENTIAL_REJECTED;
    if (credential.status === CredentialState.EXPIRED) return UpstreamState.CREDENTIAL_EXPIRED;
    return UpstreamState.NO_CREDENTIAL;
  }
  if (outOfCredits(row.id)) return UpstreamState.OUT_OF_CREDITS;
  return UpstreamState.READY;
}

/** 严重程度：同时有几种时，面板先要看哪一种。 */
const STATE_ORDER: UpstreamState[] = [
  UpstreamState.LOGGING_IN,
  UpstreamState.CREDENTIAL_REJECTED,
  UpstreamState.CREDENTIAL_EXPIRED,
  UpstreamState.NO_CREDENTIAL,
  UpstreamState.OUT_OF_CREDITS,
];

/**
 * 这个上游现在能不能接请求。
 *
 * 判据的顺序（先说最要紧的）：
 *
 *   1. 开关关着            → DISABLED（别的都不用看）
 *   2. 正在登录            → LOGGING_IN（用户正在点授权，面板该等）
 *   3. 凭据被拒过          → CREDENTIAL_REJECTED（面板该让人重登，而不是
 *                           让人以为「没登录」）
 *   4. 没有凭据            → NO_CREDENTIAL
 *   5. 凭据过期            → CREDENTIAL_EXPIRED
 *   6. 额度用尽            → OUT_OF_CREDITS
 *   7. 其余                → READY
 *
 * 平台名下有几个账号时，有一个能接就算能接（READY）；都接不了就报最要紧的
 * 那一种：面板要的是「为什么接不了」，而不是一串状态。
 */
export function upstreamState(id: UpstreamId): UpstreamState {
  const rows = accountsFor(id);
  if (!rows.length) return UpstreamState.NO_CREDENTIAL;
  if (!rows.some((row) => row.enabled)) return UpstreamState.DISABLED;
  const states = rows.filter((row) => row.enabled).map(accountState);
  if (states.includes(UpstreamState.READY)) return UpstreamState.READY;
  for (const state of STATE_ORDER) {
    if (states.includes(state)) return state;
  }
  return states[0] ?? UpstreamState.NO_CREDENTIAL;
}
