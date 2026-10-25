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
import { miniMaxApiTenantPlans, miniMaxApiTenants } from "../minimax/api.ts";
import { zcodeQuota } from "../zcode/credits.ts";
import { readCredential } from "../minimax/auth.ts";
import { fetchMiniMaxBalance, miniMaxTokenPlan } from "../minimax/credits.ts";
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
import { tokenRhythmTenants } from "../tokenrhythm/accounts.ts";
import { loadSession as loadSenseNovaSession } from "../sensenova/auth.ts";
import { poolUsage as senseNovaPoolUsage } from "../sensenova/quota.ts";
import { loadSession as loadInternAiSession, tokenFor as internAiTokenFor } from "../intern-ai/auth.ts";
import { balance as internAiBalance, creditPacks as internAiCreditPacks } from "../intern-ai/quota.ts";
import { peekCached, setCached } from "../store.ts";
import {
  listProviders,
  policyOf,
  provider,
  providerEnabled,
  setProviderEnabled,
} from "../providers.ts";
// The kinds register themselves; importing the file is what makes them known.
import "../kinds.ts";
import { kindOf } from "../provider-kinds.ts";
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

/** 上游的 id。跟聚合路由里的分组名一致。 */
/** A provider's id. The kind is not part of it: the table has the kind. */
export type UpstreamId = string;

/**
 * 这个 Provider 开着吗？
 *
 * The switch lives in the database, next to the upstream it belongs to: two
 * accounts of the same kind are switched separately.
 */
export function upstreamEnabled(id: string): boolean {
  return providerEnabled(id);
}

/** 一个上游的开关状态。 */
export interface UpstreamSwitch {
  /** 现在在生效的值。开关是热的：面板改了，下一个请求就是新的。 */
  enabled: boolean;
}

/**
 * 打开或关掉一个上游。
 *
 * 开关在数据库的 provider.enabled 上，每次现读：写进去，下一个请求就是新的。
 */
export function setUpstreamEnabled(id: string, enabled: boolean): { ok: boolean; message: string } {
  const result = setProviderEnabled(id, enabled);
  if (!result.ok) return result;
  const row = provider(id);
  return {
    ok: true,
    message: `${row?.alias || id} ${enabled ? "开着" : "关了"}，已经生效`,
  };
}

/**
 * 每个上游的开关状态。
 *
 * 开关在数据库的 provider.enabled 上，每次现读：面板改了，下一个请求就是新的。
 * 所以这里只有「现在在生效的值」—— 没有「改了还没生效」这回事。
 */
export function upstreamStates(): Record<string, UpstreamSwitch> {
  const out: Record<string, UpstreamSwitch> = {};
  for (const row of listProviders()) {
    out[row.id] = { enabled: row.enabled };
  }
  return out;
}

/**
 * 上游的地址。
 *
 * 面板上要看得见网关到底在跟谁说话：这个上游的基础地址。
 */
export function upstreamBaseUrl(id: string): string {
  const row = provider(id);
  const kind = row ? kindOf(row.kind) : null;
  return kind && row ? kind.baseUrl(row) : "";
}

/**
 * 这个上游现在的生效策略。
 *
 * 库里那一列就是生效值：面板改了它，下一个请求就是新的。
 */
export function upstreamPolicy(id: string): ContractPolicy {
  return policyEnum(policyOf(id));
}

/**
 * 这个上游名下有几个可以切换的账号。
 *
 * 账号的形态各家不一样：开放平台一把 key 一个租户，中转站一个账号一个钱包，
 * 其余上游一个账号就是一行。数法用各家自己的那份名单，不在面板那边数 ——
 * 面板数会数错（MiniMax 开放平台在账号列表里只有一行，底下却挂着几把 key）。
 */
export function upstreamAccountCount(id: string): number {
  const row = provider(id);
  if (!row) return 0;
  if (row.kind === "minimax-api") return miniMaxApiTenants(row.id).length;
  if (row.kind === "tokenrhythm") return tokenRhythmTenants(row.id).length;
  return 1;
}

/**
 * 上游的区域。
 *
 * cn / global 是契约里写的两个。MiniMax 用的是 cn / en，TokenRhythm、SenseNova
 * 与书生·端砚没有区域之分（就一个站点）。
 */
export function upstreamRegion(id: string): string {
  return provider(id)?.region ?? "";
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
 * 每个上游的模型目录，面板与 /v1/models 共用。
 *
 * 由 provider 表与 kind 注册表驱动：每一个开着的上游都有一组，模型是它自己
 * 的 kind 说的。用户自己加的 provider 也在里面 —— 以前这里写死了九个 id，
 * 于是用户加的上游能被路由到，却不出现在模型列表里。
 *
 * 只收开着的上游：一个关着的上游不公布模型，请求它的时候也给一句清楚的
 * 「没启用」，而不是把它丢给一个不会回答的上游。
 */
export function catalogGroups(): CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  for (const row of listProviders()) {
    if (!row.enabled) continue;
    const kind = kindOf(row.kind);
    if (!kind) continue;
    const models = kind.models(row);
    if (!models.length) continue;
    groups.push({ group: row.id, models });
  }
  return groups;
}

/** 一个上游现在公布几个模型。 */
export function upstreamModelCount(id: string): number {
  const row = provider(id);
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
 */
const HEALTH_CACHE_ID = "health:upstreams:v2";

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
    const cred = await readCredential(false, providerId);
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
    const cred = await readCredential(false, providerId);
    return await fetchMiniMaxCredits(cred.accessToken, "", MINIMAX_REGION === "en" ? "global" : "cn");
  } catch {
    return null;
  }
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
          tokenPlan: await miniMaxTokenPlan(300_000, row.id),
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
 * 一个上游的凭据状态。
 *
 * 各家上游的会话形状不一样，但状态字段是同一套，所以这里把它们抹平。
 */
export function upstreamCredential(id: string): CredentialView {
  const row = provider(id);
  const kind = row ? kindOf(row.kind) : null;
  if (!row || !kind) {
    return {
      kind: "session",
      status: CredentialState.MISSING,
      fingerprint: "",
      expiresAt: 0,
      remainingSec: 0,
      warning: false,
      detail: "没有这个 Provider",
      generation: 0,
    };
  }
  return kind.credential(row);
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
  const row = provider(id);
  const kind = row ? kindOf(row.kind) : null;
  if (!row || !kind) return [];
  const snapshot = fresh
    ? await freshHealthSnapshot()
    : peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? null;
  if (!snapshot) return [];
  return kind.quotas(row, snapshot);
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
  const row = provider(id);
  const kind = row ? kindOf(row.kind) : null;
  if (!row || !kind) return [];
  return kind.quotas(row, snapshot);
}


/**
 * MiniMax 的套餐额度。
 *
 * 平台给的是 ISO 字符串，这里换成毫秒时间戳。到期时间没有就是 0。
 */
export function tokenPlanView(plan: unknown): TokenPlanView | undefined {
  const raw = plan as any;
  const windows = Array.isArray(raw?.windows) ? raw.windows : [];
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
  const row = provider(id);
  const kind = row ? kindOf(row.kind) : null;
  if (!row || !kind) return false;
  const snapshot = peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? null;
  if (!snapshot) return false;
  return kind.outOfCredits(row, snapshot);
}

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
 */
export function upstreamState(id: UpstreamId): UpstreamState {
  if (!upstreamEnabled(id)) return UpstreamState.DISABLED;
  const activity = loginActivity(id);
  if (activity.loggingIn) return UpstreamState.LOGGING_IN;
  const credential = upstreamCredential(id);
  if (credential.status === CredentialState.ERROR) return UpstreamState.CREDENTIAL_REJECTED;
  if (!hasUsableCredential(credential.status)) {
    // 登录被拒过：面板上要说的是「被拒了」—— 用户能照着改密码。
    if (activity.rejected) return UpstreamState.CREDENTIAL_REJECTED;
    if (credential.status === CredentialState.EXPIRED) return UpstreamState.CREDENTIAL_EXPIRED;
    return UpstreamState.NO_CREDENTIAL;
  }
  if (outOfCredits(id)) return UpstreamState.OUT_OF_CREDITS;
  return UpstreamState.READY;
}
