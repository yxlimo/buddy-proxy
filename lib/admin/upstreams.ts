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
import { getSecret, peekCached, setCached } from "../store.ts";
import { tokenFingerprint } from "../credential.ts";
import {
  minimaxCatalogModels,
  qoderCatalogModels,
  tokenRhythmCatalogModels,
  workbuddyCatalogModels,
  type CatalogGroup,
} from "../router/catalog.ts";

/** 上游的 id。跟聚合路由里的分组名一致。 */
export type UpstreamId = "minimax" | "qoder" | "qoder-cn" | "workbuddy-cn" | "tokenrhythm";

/** 上游的开关对应的配置键。 */
export const UPSTREAM_FLAG_KEYS: Record<UpstreamId, string> = {
  minimax: "MINIMAX_CODE",
  qoder: "QODER_GLOBAL",
  "qoder-cn": "QODER_CN",
  "workbuddy-cn": "WORKBUDDY_CN",
  tokenrhythm: "TOKENRHYTHM",
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
  return configFlag(UPSTREAM_FLAG_KEYS[id], false);
}

/** 上游的名字，给人看的。 */
export const UPSTREAM_LABELS: Record<UpstreamId, string> = {
  minimax: "MiniMax Code",
  qoder: "Qoder（全球区）",
  "qoder-cn": "Qoder（中国区）",
  "workbuddy-cn": "WorkBuddy（中国区）",
  tokenrhythm: "TokenRhythm",
};

/** 所有上游，顺序就是面板里显示的顺序。 */
export const UPSTREAM_IDS: UpstreamId[] = ["minimax", "qoder", "qoder-cn", "workbuddy-cn", "tokenrhythm"];

/** 一个上游的开关状态。 */
export interface UpstreamState {
  /** 将要生效的值：面板改了但还没重启时，这里已经是改后的值。 */
  enabled: boolean;
  /** 改过、还没重启。 */
  pending: boolean;
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
 * 开关是热的：面板改了，配置重读一遍，下一个请求就是新的。所以
 *
 *   enabled  现在在生效的值
 *   pending  永远是假 —— 没有「改了还没生效」这回事
 */
export function upstreamStates(): Record<UpstreamId, UpstreamState> {
  const out = {} as Record<UpstreamId, UpstreamState>;
  for (const id of UPSTREAM_IDS) {
    const enabled = upstreamEnabled(id);
    out[id] = { enabled, pending: false };
  }
  return out;
}

/** 一个上游的开关状态。 */
export function upstreamState(id: UpstreamId): UpstreamState {
  return upstreamStates()[id];
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
  }
}

/**
 * 上游的区域。
 *
 * cn / global 是契约里写的两个。MiniMax 用的是 cn / en，TokenRhythm 没有区域。
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
  /** authenticated / missing / expired / error */
  status: string;
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
  }
}

/** 把上游自己说的状态抹平成面板用的那套。 */
function fromUpstreamStatus(raw: Record<string, unknown>, kind: string, secretId: string): CredentialView {
  const status = String(raw.status ?? "missing");
  const session = getSecret<any>(secretId);
  const token = String(session?.accessToken ?? "");
  return {
    kind,
    status: status === "anonymous" ? "missing" : status,
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
      status: "missing",
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
    status: expiresAt > Date.now() ? "authenticated" : "missing",
    fingerprint: fingerprintOf(key),
    expiresAt,
    remainingSec: expiresAt ? Math.round((expiresAt - Date.now()) / 1000) : 0,
    warning: expiresAt > 0 && expiresAt - Date.now() < 7 * 24 * 3600 * 1000,
    detail: `${tenants.length} 个租户`,
    generation: 0,
  };
}

/* ------------------------------------------------------------------ *
 * 余额
 * ------------------------------------------------------------------ */

/** 一笔赠金。 */
export interface BalanceLotView {
  id: string;
  sourceLabel: string;
  remainingCny: number;
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

/** 余额的摘要。 */
export interface BalanceView {
  /** 这个余额属于哪个上游。 */
  upstreamId: string;
  /** 属于哪个账号。同一个上游可能有几个账号（TokenRhythm 一个租户一个）。 */
  accountId: string;
  availableCny: number;
  currency: string;
  lots: BalanceLotView[];
  nextExpiryAt: number;
  expiringCny: number;
  /** 套餐额度。只有 MiniMax 有套餐。 */
  tokenPlan?: TokenPlanView;
}

/**
 * 一个上游的余额。
 *
 * TokenRhythm 有好几个租户，所以是「几条余额」而不是一条。
 *
 * `fresh` 的时候先问一遍平台：面板要看现数时才用，不然就用缓存里的。
 */
export async function upstreamBalances(id: UpstreamId, fresh = false): Promise<BalanceView[]> {
  const snapshot = fresh
    ? await freshHealthSnapshot()
    : peekCached<HealthSnapshot>(HEALTH_CACHE_ID)?.data ?? null;
  if (!snapshot) return [];
  switch (id) {
    case "minimax":
      return minimaxBalances(snapshot);
    case "qoder":
      return qoderBalances(snapshot, "global");
    case "qoder-cn":
      return qoderBalances(snapshot, "cn");
    case "workbuddy-cn":
      return workbuddyBalances(snapshot);
    case "tokenrhythm":
      return tokenrhythmBalances(snapshot);
  }
}

/** MiniMax 的余额：钱、券、赠金加在一起。 */
function minimaxBalances(snapshot: HealthSnapshot): BalanceView[] {
  const balance = snapshot.minimax?.balance as any;
  if (!balance) return [];
  const lots: BalanceLotView[] = [];
  if (Number(balance.credit ?? 0) > 0) {
    lots.push({
      id: "minimax-credit",
      sourceLabel: "赠金",
      remainingCny: Number(balance.credit ?? 0),
      expiresAt: 0,
      status: "有效",
    });
  }
  return [
    {
      upstreamId: "minimax",
      accountId: "minimax",
      availableCny: Number(balance.available ?? 0),
      currency: "CNY",
      lots,
      nextExpiryAt: 0,
      expiringCny: 0,
      tokenPlan: minimaxTokenPlan(snapshot),
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

/** Qoder 的余额：套餐额度与加油包，都是点数不是钱。 */
function qoderBalances(snapshot: HealthSnapshot, region: QoderRegion): BalanceView[] {
  const credits = snapshot.qoder?.[region]?.credits as any;
  if (!credits) return [];
  const resetsAt = credits.resetsAt ? Date.parse(String(credits.resetsAt)) : 0;
  const lots: BalanceLotView[] = [
    {
      id: `qoder-${region}-plan`,
      sourceLabel: "套餐额度",
      remainingCny: Number(credits.plan?.remaining ?? 0),
      expiresAt: resetsAt,
      status: credits.quotaExceeded ? "已用尽" : "可用",
    },
  ];
  if (Number(credits.addOn?.remaining ?? 0) > 0) {
    lots.push({
      id: `qoder-${region}-addon`,
      sourceLabel: "加油包",
      remainingCny: Number(credits.addOn?.remaining ?? 0),
      expiresAt: 0,
      status: "可用",
    });
  }
  const upstreamId = region === "global" ? "qoder" : "qoder-cn";
  return [
    {
      upstreamId,
      accountId: upstreamId,
      availableCny: Number(credits.plan?.remaining ?? 0) + Number(credits.addOn?.remaining ?? 0),
      currency: "CREDIT",
      lots,
      nextExpiryAt: resetsAt,
      expiringCny: Number(credits.plan?.remaining ?? 0),
    },
  ];
}

/** WorkBuddy 的余额：每日签到给的额度。 */
function workbuddyBalances(snapshot: HealthSnapshot): BalanceView[] {
  const credits = snapshot.workbuddy?.credits as any;
  if (!credits) return [];
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  return [
    {
      upstreamId: "workbuddy-cn",
      accountId: "workbuddy-cn",
      availableCny: Number(credits.daily ?? 0),
      currency: "CREDIT",
      lots: [
        {
          id: "workbuddy-daily",
          sourceLabel: `每日签到（连签 ${Number(credits.streakDays ?? 0)} 天）`,
          remainingCny: Number(credits.daily ?? 0),
          expiresAt: endOfDay.getTime(),
          status: credits.checkedIn ? "已领取" : "未领取",
        },
      ],
      nextExpiryAt: endOfDay.getTime(),
      expiringCny: Number(credits.daily ?? 0),
    },
  ];
}

/**
 * TokenRhythm 的余额：每个租户一条。
 *
 * 赠金按批次给，先到期先用。平台把「永不过期」的钱也算成会过期的，所以
 * 到期那笔要自己按批次算，不能信平台那个数。
 */
function tokenrhythmBalances(snapshot: HealthSnapshot): BalanceView[] {
  const tenants = (snapshot.tokenrhythm?.tenants ?? []) as TokenRhythmTenantStatus[];
  const out: BalanceView[] = [];
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
      availableCny: Number(wallet.availableCny ?? 0),
      currency: wallet.currency || "CNY",
      lots,
      nextExpiryAt: Number.isFinite(nextExpiryAt) ? nextExpiryAt : 0,
      expiringCny,
    });
  }
  return out;
}

/** 平台标记「永不过期」的那一天。 */
const PERMANENT_AT = Date.parse("2099-12-31T00:00:00Z");
