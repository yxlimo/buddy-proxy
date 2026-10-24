// lib/admin/upstreams.ts — 上游的共同视图。
//
// /health 与管理面板问的是同一批东西：哪个上游开着、它现在公布多少模型、
// 凭据是什么状态、账号上还剩多少。这个模块是唯一知道怎么去问的地方，
// 两边共用，免得各问各的、答得不一样。
//
// 开关是热的：面板改了，配置重新读一遍，下一个请求就是新的 —— 不用重启。
// 所以这里没有「待重启」那一套。

import {
  configFlag,
  configNumber,
  configOverride,
  configString,
  markHotSetting,
  reloadConfig,
} from "../config.ts";
import { MINIMAX_MODELS, type MiniMaxModel } from "../minimax/models.ts";
import {
  MINIMAX_API_MODELS,
  miniMaxApiBase,
  miniMaxApiTenantPlans,
  miniMaxApiTenants,
} from "../minimax/api.ts";
import { ZCODE_MODELS } from "../zcode/models.ts";
import { ZCODE_MESSAGES_URL } from "../zcode/transport.ts";
import { zcodeStatus } from "../zcode/auth.ts";
import { zcodeQuota } from "../zcode/credits.ts";
import { credentialStatus, readCredential } from "../minimax/auth.ts";
import { fetchMiniMaxBalance, miniMaxTokenPlan } from "../minimax/credits.ts";
import { fetchMiniMaxCredits } from "../minimax/checkin.ts";
import { MINIMAX_UPSTREAM } from "../minimax/transport.ts";
import { qoderModelsForRegion, type QoderModel } from "../qoder/models.ts";
import { ENDPOINTS as QODER_ENDPOINTS, qoderStatus, type QoderRegion } from "../qoder/auth.ts";
import { checkAccountHealth, fetchQoderCredits } from "../qoder/credits.ts";
import { ENDPOINTS as WORKBUDDY_ENDPOINTS, workbuddyStatus } from "../workbuddy/auth.ts";
import { fetchWorkBuddyCredits } from "../workbuddy/credits.ts";
import {
  setWorkbuddyModelList,
  workbuddyModelList,
  workBuddyFallbackModels,
  type WorkBuddyModel,
} from "../workbuddy/models.ts";
import { tokenRhythmStatuses, type TokenRhythmTenantStatus } from "../tokenrhythm/wallet.ts";
import { TOKENRHYTHM_API_BASE, tokenRhythmTenants } from "../tokenrhythm/accounts.ts";
import { loadSession as loadSenseNovaSession } from "../sensenova/auth.ts";
import { SENSENOVA_INFER_BASE } from "../sensenova/config.ts";
import type { SenseNovaModel } from "../sensenova/models.ts";
import {
  poolEmpty,
  poolPaused,
  poolUsage as senseNovaPoolUsage,
  totalRemaining,
  type SenseNovaPoolUsage,
} from "../sensenova/quota.ts";
import { senseNovaCatalog, senseNovaInferenceKey } from "../sensenova/transport.ts";
import { loadSession as loadInternAiSession, tokenFor as internAiTokenFor } from "../intern-ai/auth.ts";
import { INTERN_AI_DISCOVERY_API_BASE } from "../intern-ai/config.ts";
import type { InternAiCatalogModel } from "../intern-ai/models.ts";
import {
  balance as internAiBalance,
  creditPacks as internAiCreditPacks,
  type InternAiBalance,
  type InternAiCreditPack,
} from "../intern-ai/quota.ts";
import { internAiCatalog, internAiInferenceKey } from "../intern-ai/transport.ts";
import { getSecret, peekCached, setCached } from "../store.ts";
import {
  listProviders,
  provider,
  providerEnabled,
  setProviderEnabled,
  type ProviderRow,
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

export type { BalanceView, CreditView, CredentialView, HealthSnapshot, QuotaView, TokenPlanView };
import { tokenFingerprint } from "../credential.ts";
import { CredentialState, UpstreamState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { credentialState, hasUsableCredential } from "./credentials.ts";
import { loginActivity } from "./login.ts";
import {
  internAiCatalogModels,
  minimaxCatalogModels,
  miniMaxApiCatalogModels,
  zcodeCatalogModels,
  qoderCatalogModels,
  senseNovaCatalogModels,
  tokenRhythmCatalogModels,
  workbuddyCatalogModels,
  type CatalogGroup,
} from "../router/catalog.ts";

/** 上游的 id。跟聚合路由里的分组名一致。 */
/** A provider's id. The kind is not part of it: the table has the kind. */
export type UpstreamId = string;

export type LegacyUpstreamId =
  | "minimax"
  | "minimax-api"
  | "zcode"
  | "qoder"
  | "qoder-cn"
  | "workbuddy-cn"
  | "tokenrhythm"
  | "sensenova"
  | "intern-ai";


/**
 * 这个 Provider 开着吗？
 *
 * The switch lives in the database, next to the provider it belongs to: two
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
 * 开关是热的：写进数据库之后重新读一遍，下一个请求就是新的 —— 不用重启。
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
 * 开关是热的：面板改了，配置重读一遍，下一个请求就是新的。所以这里只有
 * 「现在在生效的值」—— 没有「改了还没生效」这回事。
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
 * 两个区的全部模型，开没开都算。
 *
 * 区域关着的时候，模型目录里没有它，但请求它的人仍然要得到一句清楚的话：
 * 「这个模型没有启用」而不是「没有这个模型」。所以两份都得留着。
 */
export const QODER_GLOBAL_ALL: QoderModel[] = qoderModelsForRegion("global");
export const QODER_CN_ALL: QoderModel[] = qoderModelsForRegion("cn");

/**
 * WorkBuddy 的模型目录。
 *
 * 上游自己发布的目录才是准的（它不发客户端版本就换模型），快照只是兜底。
 * 目录放在这里，是因为 /health、面板和路由都要看同一份。
 *
 * 快照一直都在：上游关着的时候不公布它，开着的时候立刻就有模型可公布 ——
 * 不用等上游那份目录下来。
 */
// The list lives with the transport that refreshes it.
let workbuddyModels: WorkBuddyModel[] = workBuddyFallbackModels();

/** WorkBuddy 现在的模型目录。 */
export function workbuddyCatalog(): WorkBuddyModel[] {
  return workbuddyModels;
}

/** 换掉 WorkBuddy 的模型目录（上游刷新之后）。 */
export function setWorkbuddyCatalog(models: WorkBuddyModel[]): void {
  workbuddyModels = models;
}

/** WorkBuddy 的模型 id 集合。目录会变，所以每次现算。 */
export function workbuddyModelIds(): Set<string> {
  return new Set(workbuddyModels.map((m) => m.id));
}

/** 现在开着的 Qoder 区域。 */
export function qoderRegions(): QoderRegion[] {
  return [
    ...(upstreamEnabled("qoder") ? (["global"] as QoderRegion[]) : []),
    ...(upstreamEnabled("qoder-cn") ? (["cn"] as QoderRegion[]) : []),
  ];
}

/**
 * SenseNova 现在的模型目录。
 *
 * 目录是问上游要来的（跟着 key 走），缓存在 lib/sensenova/transport.ts 里。
 * 这里只是把它拿出来给面板与 /health 看。
 */
export function senseNovaModels(): SenseNovaModel[] {
  return senseNovaCatalog();
}

/** 书生·端砚现在的模型目录。同样是问上游要来的。 */
export function internAiModels(): InternAiCatalogModel[] {
  return internAiCatalog();
}

/**
 * 每个上游的模型目录，面板与 /v1/models 共用。
 *
 * 只收开着的上游：一个关着的上游不公布模型，请求它的时候也给一句清楚的
 * 「没启用」，而不是把它丢给一个不会回答的上游。
 */
export function catalogGroups(): CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  const qoderGlobal = qoderVisible("global");
  const qoderCn = qoderVisible("cn");
  if (qoderGlobal.length) groups.push({ group: "qoder", models: qoderCatalogModels(qoderGlobal) });
  if (qoderCn.length) groups.push({ group: "qoder-cn", models: qoderCatalogModels(qoderCn) });
  if (upstreamEnabled("workbuddy-cn") && workbuddyModels.length) {
    groups.push({ group: "workbuddy-cn", models: workbuddyCatalogModels(workbuddyModels) });
  }
  const minimax = minimaxVisible();
  if (minimax.length) groups.push({ group: "minimax", models: minimaxCatalogModels(minimax) });
  if (upstreamEnabled("zcode")) groups.push({ group: "zcode", models: zcodeCatalogModels(ZCODE_MODELS) });
  if (upstreamEnabled("minimax-api") && miniMaxApiTenants().length) {
    groups.push({ group: "minimax-api", models: miniMaxApiCatalogModels(MINIMAX_API_MODELS) });
  }
  if (upstreamEnabled("tokenrhythm")) groups.push({ group: "tokenrhythm", models: tokenRhythmCatalogModels() });
  const senseNova = senseNovaModels();
  if (upstreamEnabled("sensenova") && senseNova.length) {
    groups.push({ group: "sensenova", models: senseNovaCatalogModels(senseNova) });
  }
  const internAi = internAiModels();
  if (upstreamEnabled("intern-ai") && internAi.length) {
    groups.push({ group: "intern-ai", models: internAiCatalogModels(internAi) });
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
 * providers arrived (each provider has its own numbers now), and an old
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
 * 每家按 provider 分开记：两个同类的账号各有各的数字。
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

/** 凭据的状态摘要。 */

/** 凭据里的那个 token 的指纹。 */
function fingerprintOf(token: string): string {
  return token ? tokenFingerprint(token) : "";
}

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

/** 把上游自己说的状态抹平成面板用的那套。 */
function fromUpstreamStatus(raw: Record<string, unknown>, kind: string, secretId: string): CredentialView {
  const status = String(raw.status ?? "missing");
  const session = getSecret<any>(secretId);
  const token = String(session?.accessToken ?? "");
  const warning = Boolean(raw.warning);
  const remainingSec = Number(raw.remainingSec ?? 0);
  // 告警要说清楚是什么告警。「快到期了」是常态（令牌一小时内就换一次），
  // 说成「状态异常」会让人以为出了故障。
  let detail = String(raw.error ?? raw.hint ?? "");
  if (!detail && warning) {
    detail =
      remainingSec > 0
        ? `令牌还有 ${Math.round(remainingSec / 60)} 分钟到期，会自动刷新`
        : "令牌即将到期，会自动刷新";
  }
  return {
    kind,
    // 上游的 "anonymous" 是「没登录」的意思（qoder、workbuddy、minimax 都
    // 这么报）—— 没有凭据，所以是 MISSING。
    status: status === "anonymous" ? CredentialState.MISSING : credentialState(status),
    fingerprint: fingerprintOf(token),
    expiresAt: raw.expiresAt ? Date.parse(String(raw.expiresAt)) : 0,
    remainingSec,
    warning,
    detail,
    generation: Number(raw.generation ?? 0),
  };
}

/** MiniMax 的凭据。 */
function minimaxCredential(): CredentialView {
  const raw = credentialStatus();
  const view = fromUpstreamStatus(raw, "session", "session:minimax");
  if (raw.mode === "file") view.detail = view.detail || "读的是桌面端的 store，刷新由桌面端负责";
  return view;
}

/**
 * MiniMax 开放平台的凭据。
 *
 * 它一把 key 就是一个租户：有几把 key 就是几个租户，一个都不剩就是没配。
 */
function miniMaxApiCredential(): CredentialView {
  const tenants = miniMaxApiTenants();
  if (!tenants.length) {
    return {
      kind: "api_key",
      status: CredentialState.MISSING,
      fingerprint: "",
      expiresAt: 0,
      remainingSec: 0,
      warning: false,
      detail: "未配置 MiniMax 开放平台的 API Key",
      generation: 0,
    };
  }
  return {
    kind: "api_key",
    status: CredentialState.AUTHENTICATED,
    fingerprint: tokenFingerprint(tenants[0].key),
    expiresAt: 0,
    remainingSec: 0,
    warning: false,
    detail: tenants.length === 1 ? "1 个租户" : `${tenants.length} 个租户`,
    generation: 0,
  };
}

/** ZCode 的凭据：zcode JWT。它没有刷新通道，过期了只能重登。 */
function zcodeCredential(): CredentialView {
  const raw = zcodeStatus();
  const view = fromUpstreamStatus(raw, "session", "session:zcode");
  return view;
}

/**
 * TokenRhythm 的凭据。
 *
 * 它是转发站：一个账号、一个钱包、一把推理用的 key。账号密码是登录用的，
 * key 是推理用的，两个不是一回事。所以这里说的是「有没有能用的登录态」。
 */
function tokenrhythmCredential(): CredentialView {
  const tenants = tokenRhythmTenants();
  if (!tenants.length) {
    return {
      kind: "session",
      status: CredentialState.MISSING,
      fingerprint: "",
      expiresAt: 0,
      remainingSec: 0,
      warning: false,
      detail: "未配置 TokenRhythm 账号",
      generation: 0,
    };
  }
  let expiresAt = 0;
  let key = "";
  for (const tenant of tenants) {
    const session = getSecret<any>(`session:tokenrhythm:${tenant.index}`);
    const at = Number(session?.expiresAtMs ?? 0);
    if (at > expiresAt) expiresAt = at;
    if (!key && tenant.apiKey) key = tenant.apiKey;
  }
  return {
    kind: "session",
    status: expiresAt > Date.now() ? CredentialState.ANONYMOUS : CredentialState.MISSING,
    fingerprint: fingerprintOf(key),
    expiresAt,
    remainingSec: expiresAt ? Math.round((expiresAt - Date.now()) / 1000) : 0,
    warning: expiresAt > 0 && expiresAt - Date.now() < 7 * 24 * 3600 * 1000,
    detail: `${tenants.length} 个租户`,
    generation: 0,
  };
}

/**
 * SenseNova 的凭据。
 *
 * 推理端点要的是一把 API key，不是 cookie：cookie 是登录态（读额度用的），
 * key 才是干活的东西。所以这里说的是「有没有那把 key」。登录之后网关会建一把
 * 并存下来，所以登录完了这里就是 AUTHENTICATED。
 */
function senseNovaCredential(): CredentialView {
  const key = senseNovaInferenceKey();
  if (!key) {
    return {
      kind: "api_key",
      status: CredentialState.MISSING,
      fingerprint: "",
      expiresAt: 0,
      remainingSec: 0,
      warning: false,
      detail: "账号上没有推理用的 API key，登录后网关将自动创建",
      generation: 0,
    };
  }
  return {
    kind: "api_key",
    status: CredentialState.AUTHENTICATED,
    fingerprint: fingerprintOf(key),
    expiresAt: 0,
    remainingSec: 0,
    warning: false,
    detail: "推理用的 API key",
    generation: 0,
  };
}

/**
 * 书生·端砚的凭据。
 *
 * 与 SenseNova 一样：推理端点认的是 key（Discovery 子站的那把），不是登录态。
 */
function internAiCredential(): CredentialView {
  const key = internAiInferenceKey();
  if (!key) {
    return {
      kind: "api_key",
      status: CredentialState.MISSING,
      fingerprint: "",
      expiresAt: 0,
      remainingSec: 0,
      warning: false,
      detail: "账号上没有 Discovery 推理 key，登录后网关将自动创建",
      generation: 0,
    };
  }
  return {
    kind: "api_key",
    status: CredentialState.AUTHENTICATED,
    fingerprint: fingerprintOf(key),
    expiresAt: 0,
    remainingSec: 0,
    warning: false,
    detail: "Discovery 的推理 key",
    generation: 0,
  };
}

/* ------------------------------------------------------------------ *
 * 余额
 * ------------------------------------------------------------------ */

/** 余额里的一笔：赠金、充值本金。 */
export interface BalanceLotView {
  id: string;
  sourceLabel: string;
  remainingCny: number;
  expiresAt: number;
  status: string;
}

/** 积分里的一笔：套餐额度、加油包、每日签到。 */
export interface CreditLotView {
  id: string;
  sourceLabel: string;
  remaining: number;
  expiresAt: number;
  status: string;
}

/** 套餐额度的一个窗口。 */
export interface TokenPlanWindowView {
  /** general / video。 */
  label: string;
  intervalPercent: number;
  weeklyPercent: number;
  intervalEndsAt: number;
  weeklyEndsAt: number;
}

/** 套餐额度。 */

/**
 * 余额：钱。
 *
 * 只有中转站这类平台有（TokenRhythm）。它跟积分不是一回事，两者不能相加。
 */

/**
 * 积分：点数。
 *
 * Qoder、WorkBuddy 这类平台的额度是这个。`total` 为 0 表示平台没报总额，
 * 前端不要显示「总额」那一项。
 */

/**
 * 一个账号的额度。
 *
 * 三样东西各是各的，**不能相加**：余额（钱）、积分（点数）、套餐额度
 * （按窗口的百分比）。后端把能拿到的都放上来，前端按有哪个显示哪个。
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
 * 快照是**按 Provider id** 存的（provider.minimax、provider.qoder-cn……），
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
 * MiniMax 的额度：套餐额度 + 账户积分。
 *
 * 它的账户余额（钱）不在这儿报 —— 这个网关花的是 coding plan，钱和积分是
 * 两回事，混在一起会让人以为套餐能拿钱买。
 */
/**
 * MiniMax 开放平台的额度。
 *
 * 一个 key 就是一份套餐，所以每个租户一条：套餐额度是百分比，账户余额不算
 * （那是另一件事）。
 */
/** ZCode 的额度：Start Plan 的额度桶。 */



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

/** 从快照里取 MiniMax 的套餐额度。 */
function minimaxTokenPlan(snapshot: HealthSnapshot): TokenPlanView | undefined {
  return tokenPlanView(snapshot.minimax?.tokenPlan);
}

/**
 * Qoder 的额度：积分（点数），不是钱。
 *
 * 两池：套餐自带的，和加油包买的。平台都报了总额、已用、剩下。
 */

/**
 * WorkBuddy 的额度：每日签到给的积分。
 *
 * 平台报的是今天有多少、今天领了多少、累计多少，没报总额，所以 total 是 0
 * （= 不知道，不是不存在）。
 */

/**
 * TokenRhythm 的额度：余额（钱），每个租户一条。
 *
 * 赠金按批次给，先到期先用。平台把「永不过期」的钱也算成会过期的，所以
 * 到期那笔要自己按批次算，不能信平台那个数。
 */

/** 平台标记「永不过期」的那一天。 */
const PERMANENT_AT = Date.parse("2099-12-31T00:00:00Z");

/**
 * SenseNova 的额度：积分（点数），不是钱。
 *
 * 平台的额度不是一个数，是几个互不相通的池子：通用池与专属池。每个池子里有
 * 周期积分（5 小时与 7 天两个滚动窗口，能用的是小的那个）与活动固定积分
 * （到账后 30 天有效）。
 *
 * 平台没报「一共给了多少积分」—— 窗口的限额是这段时间里能用多少，不是总
 * 额。所以 total 与 used 都是 0（契约里 0 = 没报），剩下的是权威的数。
 */

/**
 * 平台的时间是「本地时间（UTC+8），没有时区」。补上时区再解析。
 *
 * 不补的话，服务器在 UTC 上就会算错八个小时。
 */
function platformTimeMs(value: string): number {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const zoned = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}+08:00`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 书生·端砚的额度：墨点（点数），不是钱。
 *
 * 两样东西：
 *
 *   余额（available_credits）  账号里还剩多少墨点。这是最要紧的一个数。
 *   批次（credit packs）      平台按「一次性 / 按日 / 按月」发的墨点包：每一
 *                             批有总量、还剩多少、什么时候清空。
 *
 * 总额取「还在的批次一共给了多少墨点」—— 平台报的是每一批的总量，加起来就是
 * 这一轮发的总额。平台没报「一共发过多少」，那个数是 0（= 不知道）。
 */

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
