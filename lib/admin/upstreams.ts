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
import { credentialStatus, readCredential } from "../minimax/auth.ts";
import { fetchMiniMaxBalance, miniMaxTokenPlan } from "../minimax/credits.ts";
import { MINIMAX_UPSTREAM } from "../minimax/transport.ts";
import { qoderModelsForRegion, type QoderModel } from "../qoder/models.ts";
import { ENDPOINTS as QODER_ENDPOINTS, qoderStatus, type QoderRegion } from "../qoder/auth.ts";
import { checkAccountHealth, fetchQoderCredits } from "../qoder/credits.ts";
import { ENDPOINTS as WORKBUDDY_ENDPOINTS, workbuddyStatus } from "../workbuddy/auth.ts";
import { fetchWorkBuddyCredits } from "../workbuddy/credits.ts";
import { workBuddyFallbackModels, type WorkBuddyModel } from "../workbuddy/models.ts";
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
import { tokenFingerprint } from "../credential.ts";
import { CredentialState, UpstreamState } from "../gen/buddy/admin/v1/admin_pb.ts";
import { credentialState, hasUsableCredential } from "./credentials.ts";
import { loginActivity } from "./login.ts";
import {
  internAiCatalogModels,
  minimaxCatalogModels,
  qoderCatalogModels,
  senseNovaCatalogModels,
  tokenRhythmCatalogModels,
  workbuddyCatalogModels,
  type CatalogGroup,
} from "../router/catalog.ts";

/** 上游的 id。跟聚合路由里的分组名一致。 */
export type UpstreamId =
  | "minimax"
  | "qoder"
  | "qoder-cn"
  | "workbuddy-cn"
  | "tokenrhythm"
  | "sensenova"
  | "intern-ai";

/** 上游的开关对应的配置键。 */
export const UPSTREAM_FLAG_KEYS: Record<UpstreamId, string> = {
  minimax: "MINIMAX_CODE",
  qoder: "QODER_GLOBAL",
  "qoder-cn": "QODER_CN",
  "workbuddy-cn": "WORKBUDDY_CN",
  tokenrhythm: "TOKENRHYTHM",
  sensenova: "SENSENOVA",
  "intern-ai": "INTERN_AI",
};

// The switches are read on every request, so the panel can change one and the
// next request sees it — no restart.
for (const key of Object.values(UPSTREAM_FLAG_KEYS)) markHotSetting(key);

/**
 * 这个上游开着吗？问的是现在在生效的值。
 *
 * 面板改开关之后写进数据库，配置重新读一遍，下一个请求就是新的了 —— 所以这里
 * 不需要「待重启」那一套。
 */
export function upstreamEnabled(id: UpstreamId): boolean {
  const key = UPSTREAM_FLAG_KEYS[id];
  // 不认识的上游：没有开关，就是没开。
  if (!key) return false;
  return configFlag(key, false);
}

/** 上游的名字，给人看的。 */
export const UPSTREAM_LABELS: Record<UpstreamId, string> = {
  minimax: "MiniMax Code",
  qoder: "Qoder（全球区）",
  "qoder-cn": "Qoder（中国区）",
  "workbuddy-cn": "WorkBuddy（中国区）",
  tokenrhythm: "TokenRhythm",
  sensenova: "SenseNova",
  "intern-ai": "书生·端砚",
};

/** 所有上游，顺序就是面板里显示的顺序。 */
export const UPSTREAM_IDS: UpstreamId[] = [
  "minimax",
  "qoder",
  "qoder-cn",
  "workbuddy-cn",
  "tokenrhythm",
  "sensenova",
  "intern-ai",
];

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
export function setUpstreamEnabled(id: UpstreamId, enabled: boolean): { ok: boolean; message: string } {
  const key = UPSTREAM_FLAG_KEYS[id];
  if (!key) return { ok: false, message: `不认识的上游：${id}` };
  configOverride(key, enabled ? "true" : "false");
  reloadConfig();
  return { ok: true, message: `${UPSTREAM_LABELS[id]} ${enabled ? "开着" : "关了"}，已经生效` };
}

/**
 * 每个上游的开关状态。
 *
 * 开关是热的：面板改了，配置重读一遍，下一个请求就是新的。所以这里只有
 * 「现在在生效的值」—— 没有「改了还没生效」这回事。
 */
export function upstreamStates(): Record<UpstreamId, UpstreamSwitch> {
  const out = {} as Record<UpstreamId, UpstreamSwitch>;
  for (const id of UPSTREAM_IDS) {
    out[id] = { enabled: upstreamEnabled(id) };
  }
  return out;
}

/**
 * 上游的地址。
 *
 * 面板上要看得见网关到底在跟谁说话：这个上游的基础地址。
 */
export function upstreamBaseUrl(id: UpstreamId): string {
  switch (id) {
    case "minimax":
      return MINIMAX_UPSTREAM.replace(/\/messages$/, "");
    case "qoder":
      return QODER_ENDPOINTS.global.infer.replace(/\/model\/v1\/chat\/completions$/, "");
    case "qoder-cn":
      return QODER_ENDPOINTS.cn.infer.replace(/\/model\/v1\/chat\/completions$/, "");
    case "workbuddy-cn":
      return WORKBUDDY_ENDPOINTS.cn.base;
    case "tokenrhythm":
      return TOKENRHYTHM_API_BASE;
    case "sensenova":
      return SENSENOVA_INFER_BASE;
    case "intern-ai":
      return INTERN_AI_DISCOVERY_API_BASE;
  }
}

/**
 * 上游的区域。
 *
 * cn / global 是契约里写的两个。MiniMax 用的是 cn / en，TokenRhythm、SenseNova
 * 与书生·端砚没有区域之分（就一个站点）。
 */
export function upstreamRegion(id: UpstreamId): string {
  switch (id) {
    case "minimax":
      return MINIMAX_REGION;
    case "qoder":
      return "global";
    case "qoder-cn":
      return "cn";
    case "workbuddy-cn":
      return "cn";
    case "tokenrhythm":
      return "";
    case "sensenova":
      return "";
    case "intern-ai":
      return "";
  }
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
export function upstreamModelCount(id: UpstreamId): number {
  switch (id) {
    case "minimax":
      return minimaxVisible().length;
    case "qoder":
      return qoderVisible("global").length;
    case "qoder-cn":
      return qoderVisible("cn").length;
    case "workbuddy-cn":
      return upstreamEnabled("workbuddy-cn") ? workbuddyModels.length : 0;
    case "tokenrhythm":
      return upstreamEnabled("tokenrhythm") ? tokenRhythmCatalogModels().length : 0;
    case "sensenova":
      return upstreamEnabled("sensenova") ? senseNovaModels().length : 0;
    case "intern-ai":
      return upstreamEnabled("intern-ai") ? internAiModels().length : 0;
  }
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
export interface HealthSnapshot {
  qoder: Record<string, { account: unknown; credits: unknown }>;
  minimax: { balance: unknown; tokenPlan: unknown };
  workbuddy: { credits: unknown };
  tokenrhythm: { tenants: unknown };
  /** SenseNova 的积分池。 */
  sensenova: { pools: unknown };
  /** 书生·端砚的墨点：余额与批次。 */
  internAi: { balance: unknown; packs: unknown };
}

const HEALTH_CACHE_ID = "health:upstreams";

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
export async function miniMaxBalance(): Promise<unknown> {
  try {
    const cred = await readCredential();
    return await fetchMiniMaxBalance(cred.accessToken, MINIMAX_REGION === "en" ? "global" : "cn");
  } catch {
    return null;
  }
}

/**
 * SenseNova 的积分池。
 *
 * 问的是控制台（要登录态），没登录就问不了 —— 那是「不知道」，不是「没有」。
 */
async function senseNovaPools(): Promise<unknown> {
  if (!upstreamEnabled("sensenova")) return null;
  const session = loadSenseNovaSession();
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
async function internAiCredits(): Promise<{ balance: unknown; packs: unknown }> {
  if (!upstreamEnabled("intern-ai")) return { balance: null, packs: null };
  const session = loadInternAiSession();
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

/** 问一遍上游，把答案记下来。 */
export async function refreshHealthSnapshot(): Promise<void> {
  const qoder: HealthSnapshot["qoder"] = {};
  for (const region of qoderRegions()) {
    let account: unknown;
    try {
      account = await checkAccountHealth(region);
    } catch (e) {
      account = { region, usable: false, reason: (e as Error)?.message };
    }
    qoder[region] = { account, credits: await fetchQoderCredits(region) };
  }
  const snapshot: HealthSnapshot = {
    qoder,
    minimax: { balance: await miniMaxBalance(), tokenPlan: await miniMaxTokenPlan() },
    workbuddy: { credits: await fetchWorkBuddyCredits() },
    tokenrhythm: { tenants: await tokenRhythmStatuses() },
    sensenova: { pools: await senseNovaPools() },
    internAi: await internAiCredits(),
  };
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
export interface CredentialView {
  /** session / api_key / login / plan_key */
  kind: string;
  /** authenticated / missing / expired / error / usable / anonymous。 */
  status: CredentialState;
  /** 只留前几位。 */
  fingerprint: string;
  /** 到期时间（毫秒）。 */
  expiresAt: number;
  /** 还剩多少秒。 */
  remainingSec: number;
  warning: boolean;
  detail: string;
  generation: number;
}

/** 凭据里的那个 token 的指纹。 */
function fingerprintOf(token: string): string {
  return token ? tokenFingerprint(token) : "";
}

/**
 * 一个上游的凭据状态。
 *
 * 各家上游的会话形状不一样，但状态字段是同一套，所以这里把它们抹平。
 */
export function upstreamCredential(id: UpstreamId): CredentialView {
  switch (id) {
    case "minimax":
      return minimaxCredential();
    case "qoder":
      return qoderCredential("global");
    case "qoder-cn":
      return qoderCredential("cn");
    case "workbuddy-cn":
      return workbuddyCredential("cn");
    case "tokenrhythm":
      return tokenrhythmCredential();
    case "sensenova":
      return senseNovaCredential();
    case "intern-ai":
      return internAiCredential();
  }
}

/** 把上游自己说的状态抹平成面板用的那套。 */
function fromUpstreamStatus(raw: Record<string, unknown>, kind: string, secretId: string): CredentialView {
  const status = String(raw.status ?? "missing");
  const session = getSecret<any>(secretId);
  const token = String(session?.accessToken ?? "");
  return {
    kind,
    // 上游的 "anonymous" 是「没登录」的意思（qoder、workbuddy、minimax 都
    // 这么报）—— 没有凭据，所以是 MISSING。
    status: status === "anonymous" ? CredentialState.MISSING : credentialState(status),
    fingerprint: fingerprintOf(token),
    expiresAt: raw.expiresAt ? Date.parse(String(raw.expiresAt)) : 0,
    remainingSec: Number(raw.remainingSec ?? 0),
    warning: Boolean(raw.warning),
    detail: String(raw.error ?? raw.hint ?? ""),
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

/** Qoder 的凭据。 */
function qoderCredential(region: QoderRegion): CredentialView {
  return fromUpstreamStatus(qoderStatus(region), "session", `session:qoder:${region}`);
}

/** WorkBuddy 的凭据。 */
function workbuddyCredential(region: "cn"): CredentialView {
  return fromUpstreamStatus(workbuddyStatus(region), "session", `session:workbuddy:${region}`);
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
      detail: "没有配置 TokenRhythm 账号",
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
      detail: "账号上没有推理用的 API key，登录之后网关会建一把",
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
      detail: "账号上没有 Discovery 的推理 key，登录之后网关会建一把",
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
export interface TokenPlanView {
  windows: TokenPlanWindowView[];
}

/**
 * 余额：钱。
 *
 * 只有中转站这类平台有（TokenRhythm）。它跟积分不是一回事，两者不能相加。
 */
export interface BalanceView {
  availableCny: number;
  currency: string;
  lots: BalanceLotView[];
  nextExpiryAt: number;
  expiringCny: number;
}

/**
 * 积分：点数。
 *
 * Qoder、WorkBuddy 这类平台的额度是这个。`total` 为 0 表示平台没报总额，
 * 前端不要显示「总额」那一项。
 */
export interface CreditView {
  total: number;
  used: number;
  remaining: number;
  lots: CreditLotView[];
  note: string;
}

/**
 * 一个账号的额度。
 *
 * 三样东西各是各的，**不能相加**：余额（钱）、积分（点数）、套餐额度
 * （按窗口的百分比）。后端把能拿到的都放上来，前端按有哪个显示哪个。
 */
export interface QuotaView {
  /** 这个额度属于哪个上游。 */
  upstreamId: string;
  /** 属于哪个账号。同一个上游可能有几个账号（TokenRhythm 一个租户一个）。 */
  accountId: string;
  balance?: BalanceView;
  credits?: CreditView;
  tokenPlan?: TokenPlanView;
}

/**
 * 一个上游的额度，每个账号一条。
 *
 * TokenRhythm 有好几个租户，所以是「几条」而不是一条。
 *
 * `fresh` 的时候先问一遍平台：面板要看现数时才用，不然就用缓存里的。
 */
export async function upstreamQuotas(id: UpstreamId, fresh = false): Promise<QuotaView[]> {
  const snapshot = fresh
    ? await freshHealthSnapshot()
    : peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? null;
  if (!snapshot) return [];
  switch (id) {
    case "minimax":
      return minimaxQuotas(snapshot);
    case "qoder":
      return qoderQuotas(snapshot, "global");
    case "qoder-cn":
      return qoderQuotas(snapshot, "cn");
    case "workbuddy-cn":
      return workbuddyQuotas(snapshot);
    case "tokenrhythm":
      return tokenrhythmQuotas(snapshot);
    case "sensenova":
      return senseNovaQuotas(snapshot);
    case "intern-ai":
      return internAiQuotas(snapshot);
  }
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

/** 从快照里取一个上游的额度，不问上游。 */
function upstreamQuotasCached(id: UpstreamId): QuotaView[] {
  const snapshot = peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? null;
  if (!snapshot) return [];
  switch (id) {
    case "minimax":
      return minimaxQuotas(snapshot);
    case "qoder":
      return qoderQuotas(snapshot, "global");
    case "qoder-cn":
      return qoderQuotas(snapshot, "cn");
    case "workbuddy-cn":
      return workbuddyQuotas(snapshot);
    case "tokenrhythm":
      return tokenrhythmQuotas(snapshot);
    case "sensenova":
      return senseNovaQuotas(snapshot);
    case "intern-ai":
      return internAiQuotas(snapshot);
  }
}

/**
 * MiniMax 的额度：套餐额度 + 账户积分。
 *
 * 它的账户余额（钱）不在这儿报 —— 这个网关花的是 coding plan，钱和积分是
 * 两回事，混在一起会让人以为套餐能拿钱买。
 */
function minimaxQuotas(snapshot: HealthSnapshot): QuotaView[] {
  const balance = snapshot.minimax?.balance as any;
  const plan = minimaxTokenPlan(snapshot);
  if (!balance && !plan) return [];
  const remaining = Number(balance?.credit ?? 0);
  return [
    {
      upstreamId: "minimax",
      accountId: "minimax",
      // 积分：账户上赠送的那部分。平台不报总额，所以 total 是 0。
      credits: {
        total: 0,
        used: 0,
        remaining,
        lots: remaining > 0
          ? [
              {
                id: "minimax-credit",
                sourceLabel: "账户积分",
                remaining,
                expiresAt: 0,
                status: "有效",
              },
            ]
          : [],
        note: "账户上的积分",
      },
      ...(plan ? { tokenPlan: plan } : {}),
    },
  ];
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

/** 从快照里取 MiniMax 的套餐额度。 */
function minimaxTokenPlan(snapshot: HealthSnapshot): TokenPlanView | undefined {
  return tokenPlanView(snapshot.minimax?.tokenPlan);
}

/**
 * Qoder 的额度：积分（点数），不是钱。
 *
 * 两池：套餐自带的，和加油包买的。平台都报了总额、已用、剩下。
 */
function qoderQuotas(snapshot: HealthSnapshot, region: QoderRegion): QuotaView[] {
  const credits = snapshot.qoder?.[region]?.credits as any;
  if (!credits) return [];
  const resetsAt = credits.resetsAt ? Date.parse(String(credits.resetsAt)) : 0;
  const lots: CreditLotView[] = [
    {
      id: `qoder-${region}-plan`,
      sourceLabel: "套餐额度",
      remaining: Number(credits.plan?.remaining ?? 0),
      expiresAt: resetsAt,
      status: credits.quotaExceeded ? "已用尽" : "可用",
    },
  ];
  if (Number(credits.addOn?.remaining ?? 0) > 0) {
    lots.push({
      id: `qoder-${region}-addon`,
      sourceLabel: "加油包",
      remaining: Number(credits.addOn?.remaining ?? 0),
      expiresAt: 0,
      status: "可用",
    });
  }
  const upstreamId = region === "global" ? "qoder" : "qoder-cn";
  return [
    {
      upstreamId,
      accountId: upstreamId,
      credits: {
        total: Number(credits.plan?.total ?? 0) + Number(credits.addOn?.total ?? 0),
        used: Number(credits.plan?.used ?? 0) + Number(credits.addOn?.used ?? 0),
        remaining: Number(credits.plan?.remaining ?? 0) + Number(credits.addOn?.remaining ?? 0),
        lots,
        note: "平台积分",
      },
    },
  ];
}

/**
 * WorkBuddy 的额度：每日签到给的积分。
 *
 * 平台报的是今天有多少、今天领了多少、累计多少，没报总额，所以 total 是 0
 * （= 不知道，不是不存在）。
 */
function workbuddyQuotas(snapshot: HealthSnapshot): QuotaView[] {
  const credits = snapshot.workbuddy?.credits as any;
  if (!credits) return [];
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const daily = Number(credits.daily ?? 0);
  return [
    {
      upstreamId: "workbuddy-cn",
      accountId: "workbuddy-cn",
      credits: {
        total: 0,
        used: 0,
        remaining: daily,
        lots: [
          {
            id: "workbuddy-daily",
            sourceLabel: `每日签到（连签 ${Number(credits.streakDays ?? 0)} 天）`,
            remaining: daily,
            expiresAt: endOfDay.getTime(),
            status: credits.checkedIn ? "已领取" : "未领取",
          },
        ],
        note: `每天 ${daily} 点，连签 ${Number(credits.streakDays ?? 0)} 天`,
      },
    },
  ];
}

/**
 * TokenRhythm 的额度：余额（钱），每个租户一条。
 *
 * 赠金按批次给，先到期先用。平台把「永不过期」的钱也算成会过期的，所以
 * 到期那笔要自己按批次算，不能信平台那个数。
 */
function tokenrhythmQuotas(snapshot: HealthSnapshot): QuotaView[] {
  const tenants = (snapshot.tokenrhythm?.tenants ?? []) as TokenRhythmTenantStatus[];
  const out: QuotaView[] = [];
  for (const tenant of tenants) {
    const wallet = tenant.wallet;
    if (!wallet) continue;
    const lots: BalanceLotView[] = (tenant.credits?.list ?? []).map((lot) => ({
      id: lot.id,
      sourceLabel: lot.sourceLabel || lot.source,
      remainingCny: Number(lot.remainingCny ?? 0),
      expiresAt: lot.expiresAt ? Date.parse(String(lot.expiresAt)) : 0,
      status: lot.status || "",
    }));
    const nextExpiryAt = tenant.credits?.summary?.nextExpiryAt
      ? Date.parse(String(tenant.credits.summary.nextExpiryAt))
      : 0;
    // 平台用 2099-12-31 标记「永不过期」，那一批不算会过期。
    const expiringCny = lots
      .filter((lot) => lot.expiresAt > 0 && lot.expiresAt < PERMANENT_AT)
      .reduce((sum, lot) => sum + lot.remainingCny, 0);
    out.push({
      upstreamId: "tokenrhythm",
      // 一个租户一个账号：面板靠这个分清是哪一条余额。
      accountId: `tokenrhythm:${tenant.index}`,
      balance: {
        availableCny: Number(wallet.availableCny ?? 0),
        currency: wallet.currency || "CNY",
        lots,
        nextExpiryAt: Number.isFinite(nextExpiryAt) ? nextExpiryAt : 0,
        expiringCny,
      },
    });
  }
  return out;
}

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
function senseNovaQuotas(snapshot: HealthSnapshot): QuotaView[] {
  const usage = snapshot.sensenova?.pools as SenseNovaPoolUsage | null;
  if (!usage?.pools?.length) return [];
  // 能服务模型的池子才算数：没有模型挂在它上面的池子，扣不到。
  const pools = usage.pools.filter((pool) => pool.modelIds.length > 0);
  if (!pools.length) return [];
  const lots: CreditLotView[] = pools.map((pool) => ({
    id: pool.id,
    sourceLabel: pool.name || pool.id,
    remaining: totalRemaining(pool),
    // 活动积分有到期日；周期积分靠窗口重置，没有到期日。
    expiresAt: pool.nearestGrantExpiry ? pool.nearestGrantExpiry * 1000 : 0,
    status: poolEmpty(pool) ? "已用尽" : poolPaused(pool) ? "窗口用尽" : "可用",
  }));
  const remaining = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  const plan = usage.plan?.name ? `${usage.plan.name}：` : "";
  return [
    {
      upstreamId: "sensenova",
      accountId: "sensenova",
      credits: {
        total: 0,
        used: 0,
        remaining,
        lots,
        note: `${plan}${pools.length} 个积分池，周期积分取 5 小时与 7 天窗口里小的那个`,
      },
    },
  ];
}

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
function internAiQuotas(snapshot: HealthSnapshot): QuotaView[] {
  const balance = snapshot.internAi?.balance as InternAiBalance | null;
  if (!balance) return [];
  const packs = (snapshot.internAi?.packs as InternAiCreditPack[] | null) ?? [];
  // 只有还在的批次算数：过期与作废的不算。
  const alive = packs.filter((pack) => pack.status === "available" || pack.status === "unused");
  const lots: CreditLotView[] = alive.map((pack) => ({
    id: pack.id,
    sourceLabel: pack.remark || pack.cycleType || pack.id,
    remaining: pack.remainingCredits,
    expiresAt: platformTimeMs(pack.expireAt) || platformTimeMs(pack.cycleEndAt),
    status: pack.status === "unused" ? "未使用" : "可用",
  }));
  const total = alive.reduce((sum, pack) => sum + pack.totalCredits, 0);
  return [
    {
      upstreamId: "intern-ai",
      accountId: "intern-ai",
      credits: {
        total,
        used: balance.used,
        remaining: balance.availableCredits,
        lots,
        note: `墨点：余额 ${balance.availableCredits}${alive.length ? `，${alive.length} 个批次` : ""}`,
      },
    },
  ];
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
export function outOfCredits(id: UpstreamId): boolean {
  const snapshot = peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? null;
  if (!snapshot) return false;
  switch (id) {
    case "minimax": {
      // 账户余额不是那道闸：这个网关用的是 coding plan，余额是 0 也能跑
      // （实测过：余额 0，plan 99%，请求正常）。看 plan 的窗口。
      const plan = snapshot.minimax?.tokenPlan as any;
      const windows = (plan?.windows ?? []) as any[];
      if (!windows.length) return false;
      return windows.some((w) => Number(w.intervalPercent ?? 100) <= 0 || Number(w.weeklyPercent ?? 100) <= 0);
    }
    case "qoder":
    case "qoder-cn": {
      const region = id === "qoder-cn" ? "cn" : "global";
      const credits = snapshot.qoder?.[region]?.credits as any;
      if (!credits) return false;
      const plan = Number(credits.plan?.remaining ?? 0);
      const addOn = Number(credits.addOn?.remaining ?? 0);
      // 上游自己说的：超了就是超了。
      if (credits.quotaExceeded === true) return true;
      // 两池都空才算没。加购那池还在的时候照样能跑（实测过：套餐 300/300，
      // 加购还有 100，quotaExceeded 是 false，请求正常）。
      // 套餐用光只是把活动藏起来，不影响请求。
      return plan <= 0 && addOn <= 0;
    }
    case "workbuddy-cn": {
      const credits = snapshot.workbuddy?.credits as any;
      if (!credits) return false;
      return Number(credits.daily ?? 0) <= 0;
    }
    case "tokenrhythm": {
      const tenants = (snapshot.tokenrhythm?.tenants ?? []) as TokenRhythmTenantStatus[];
      const wallets = tenants.map((t) => t.wallet).filter(Boolean) as any[];
      if (!wallets.length) return false;
      return wallets.every((w) => Number(w.availableCny ?? 0) <= 0);
    }
    case "sensenova": {
      const usage = snapshot.sensenova?.pools as SenseNovaPoolUsage | null;
      const pools = (usage?.pools ?? []).filter((pool) => pool.modelIds.length > 0);
      if (!pools.length) return false;
      // 每个能服务模型的池子都空了，才是真的没有积分了。
      return pools.every((pool) => poolEmpty(pool));
    }
    case "intern-ai": {
      const balance = snapshot.internAi?.balance as InternAiBalance | null;
      if (!balance) return false;
      if (balance.availableCredits <= 0) return true;
      // 窗口用满了也是用完了：这段时间里就是不能再花。
      for (const window of [balance.window5h, balance.window7d]) {
        if (window.enabled && window.remainingCredits <= 0) return true;
      }
      return false;
    }
  }
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
