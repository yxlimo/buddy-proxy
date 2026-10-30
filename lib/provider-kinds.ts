// lib/provider-kinds.ts — the registry: what each kind of upstream knows how to do.
//
// The behaviour of a kind used to live in seven switch statements, one per
// question ("what is its address", "what models does it have", "how much is
// left", …). Adding a kind meant writing a case in each of them, and two
// accounts of the same kind could not be told apart at all.
//
// A kind is one entry here instead. The row says which kind it is and which
// one of that kind it is; the registry says how to talk to that kind.
//
// What is NOT here: the call to the upstream. That lives with the transport it
// belongs to (lib/router/upstreams/) — one dispatch, not one per question.

import type Koa from "koa";
import { CredentialState } from "./gen/buddy/admin/v1/admin_pb.ts";
import type { Json } from "./json.ts";
import type { ProviderPolicy, ProviderRow } from "./providers.ts";
import type { CatalogModel } from "./router/catalog.ts";
import type { Dialect } from "./router/deliver.ts";
import type { Route } from "./router/routes.ts";
// 只为 `dispatch` 的参数类型：upstreams/tokenrhythm.ts 从这边取 kindOf，值上不互相引用。
import type { UpstreamContext } from "./router/upstreams/index.ts";
/** 面板上登录的方式。 */
export type ProviderLoginMethod = "device" | "browser" | "password" | "code" | "api_key";

/** 一次签到的结果。 */
export interface BenefitOutcome {
  /** 上游的 id。 */
  upstream: string;
  /** 成了没有。 */
  ok: boolean;
  /** 拿到的积分数。 */
  credits: number;
  /** 给人看的几行话。 */
  report: string[];
  /** 什么时候跑的。 */
  at: string;
}

/* ------------------------------------------------------------------ *
 * The shapes the panel reads
 * ------------------------------------------------------------------ */

/** 一条凭据的样子。 */
export interface CredentialView {
  /** session / api_key / login / plan_key */
  kind: string;
  /** 契约里的 CredentialState。 */
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

/** 积分批次。 */
export interface CreditLotView {
  id: string;
  sourceLabel: string;
  remaining: number;
  expiresAt: number;
  status: string;
}

/** 余额批次。 */
export interface BalanceLotView {
  id: string;
  sourceLabel: string;
  remainingCny: number;
  expiresAt: number;
  status: string;
}

/** 积分：点数。 */
export interface CreditView {
  total: number;
  used: number;
  remaining: number;
  lots: CreditLotView[];
  note: string;
}

/** 余额：钱。 */
export interface BalanceView {
  availableCny: number;
  currency: string;
  lots: BalanceLotView[];
  /** 最近到期的那批的到期时间。 */
  nextExpiryAt: number;
  /** 会过期的那部分。 */
  expiringCny: number;
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

/** 套餐额度：按窗口的百分比。 */
export interface TokenPlanView {
  windows: TokenPlanWindowView[];
}

/** 一个额度。 */
export interface QuotaView {
  /** 这个额度属于哪个 provider。 */
  upstreamId: string;
  /** 属于哪个账号。 */
  accountId: string;
  balance?: BalanceView;
  credits?: CreditView;
  tokenPlan?: TokenPlanView;
}

/**
 * /health 里的快照：各家报上来的原始数字。
 *
 * 按上游分开：两个同类的上游各有各的数字。
 */
export interface HealthSnapshot {
  qoder: Record<string, { account: unknown; credits: unknown; quota?: unknown }>;
  minimax: Record<
    string,
    {
      balance: unknown;
      tokenPlan: unknown;
      credits: unknown;
      /** 积分，以及「plan 见底后自动扣积分」的开关：plan 窗口见底时看这两个。 */
      points?: { amount: number | null; at: number };
      creditFallbackEnabled?: { enabled: boolean | null; at: number };
    }
  >;
  /** ZCode 的 Start Plan 额度。 */
  zcode: Record<string, { quota: unknown }>;
  workbuddy: Record<string, { credits: unknown }>;
  tokenrhythm: Record<string, { tenants: unknown }>;
  /** SenseNova 的积分池。 */
  sensenova: Record<string, { pools: unknown }>;
  /** 书生·端砚的墨点：余额与批次。 */
  internAi: Record<string, { balance: unknown; packs: unknown }>;
  /** 七牛云的资源包。 */
  qiniu: Record<string, { quota: unknown }>;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/** 一个种类知道的事。 */
export interface ProviderKind {
  /** 种类名：provider 表里的 kind。 */
  kind: string;
  /** 面板上显示的名字（没有别名的时候用这个）。 */
  label: string;
  /** 登录办法。 */
  login: ProviderLoginMethod;
  /** 这个种类要区域吗（Qoder 有全球区与中国区之分）。 */
  needsRegion?: boolean;
  /**
   * 是开放 API 平台吗（TokenRhythm、SenseNova、书生·端砚）。
   *
   * 平台是直接转发的：agent 写的请求原样过去，会话相关的头也跟着过去。
   * 模拟客户端的那些（Qoder、WorkBuddy、MiniMax Code、ZCode）是按客户端的
   * 样子重建请求的 —— 多余的头直接无视。
   */
  openPlatform?: boolean;
  /** 区域都有哪些。 */
  regions?: string[];
  /**
   * 这一类上游支持的生效策略。
   *
   * 策略是「名下的多个账号怎么选」：只有一个账号的上游选了也没有用，所以
   * 那些种类只给「单一」。
   */
  policies?: ProviderPolicy[];
  /** 基础地址。 */
  baseUrl(provider: ProviderRow): string;
  /** 凭据。 */
  credential(provider: ProviderRow): CredentialView;
  /** 模型目录。 */
  models(provider: ProviderRow): CatalogModel[];
  /** 额度。 */
  quotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[];
  /** 额度用尽了吗（读不到就说不知道）。 */
  outOfCredits(provider: ProviderRow, snapshot: HealthSnapshot): boolean;
  /**
   * 额度什么时候回来（Unix 毫秒）。null = 不知道。
   *
   * 只在账号确实见底时有意义：这是「等多久能再用」，不是「下次重置」。
   */
  recoverAt?(provider: ProviderRow, snapshot: HealthSnapshot): number | null;
  /**
   * 这一类上游的每日签到。
   *
   * 没有这一项的种类不签到：签到是账号的事，写在种类里，加一个种类就是
   * 登记一次，而不是在签到那里再写一个 if/else。
   */
  benefits?(provider: ProviderRow): Promise<BenefitOutcome>;
  /**
   * 定时刷新这个上游的会话。
   *
   * 官方客户端自己按时间表换令牌，不等人来点。网关也这样：种类说得出自己
   * 怎么刷，定时器（lib/periodic.ts）只管按时叫它。
   *
   * 没有这一项的种类不刷：它的凭据不是会话（key、账号密码），不轮换。
   *
   * 这是**唯一**换令牌的地方：请求那一条路不换（它看到过期就报错）。令牌
   * 是一次性的，两处同时换，平台会当成重放，把整个会话撤掉。
   */
  refresh?(provider: ProviderRow): Promise<void>;
  /**
   * 定时扫描这个上游的状态，把「现在该用哪个账户」定下来。
   *
   * 中转站的赠金会过期：最先到期的那个账户该先用，而那是余额说了算。
   * 定时器（lib/periodic.ts）按时调它。
   */
  scan?(provider: ProviderRow): Promise<void>;
  /**
   * 这个失败是不是「余额不足」。
   *
   * 余额到期优先是个包过的单一：钉住的账户接不了时，这个钩子说「是余额
   * 没了」，于是重新扫描、重新钉一个别的接手。
   */
  isRequestMissingBalance?(error: unknown): boolean;
  /**
   * 这一类上游怎么转发。没有它就说明这个种类还没接。
   *
   * 请求怎么发出去、答案怎么写回客户端，是转发那一条路的事
   * （lib/router/upstreams/）。写在种类里，接一个种类就是登记一次，
   * 而不是在 `router-proxy.ts` 的 switch 里再加一个 case。
   */
  dispatch?(
    ctx: UpstreamContext,
    body: Json,
    route: Route,
    dialect: Dialect,
    stream: boolean,
    out: Koa.Context,
  ): Promise<void>;
}

/** 把上游报的状态翻成面板要的那一套。 */
export function fromUpstreamStatus(raw: Record<string, unknown>, kind: string): CredentialView {
  const status = String(raw.status ?? "");
  const remainingSec = Number(raw.remainingSec ?? 0);
  const expiresAt = raw.expiresAt ? Date.parse(String(raw.expiresAt)) : 0;
  const warning = raw.warning === true;
  const detail = String(raw.detail ?? "");
  return {
    kind,
    status: credentialStateOf(status),
    fingerprint: String(raw.fingerprint ?? ""),
    expiresAt,
    remainingSec,
    warning,
    detail: warning && !detail ? "凭据即将到期" : detail,
    generation: Number(raw.generation ?? 0),
  };
}

/** 上游的状态词 → 契约里的枚举。 */
function credentialStateOf(status: string): CredentialState {
  switch (status) {
    case "authenticated":
      return CredentialState.AUTHENTICATED;
    case "expired":
      return CredentialState.EXPIRED;
    case "error":
      return CredentialState.ERROR;
    case "usable":
      return CredentialState.USABLE;
    case "anonymous":
      // The upstreams that report "anonymous" mean it as "not logged in"
      // (qoder, workbuddy, minimax all do): no credential, so it is missing.
      return CredentialState.MISSING;
    case "missing":
      return CredentialState.MISSING;
    default:
      return CredentialState.MISSING;
  }
}

const REGISTRY = new Map<string, ProviderKind>();

/** 登记一个种类。 */
export function registerKind(kind: ProviderKind): void {
  REGISTRY.set(kind.kind, kind);
}

/** 一个种类。 */
export function kindOf(kind: string): ProviderKind | null {
  return REGISTRY.get(kind) ?? null;
}

/**
 * 这一类上游支持的策略。
 *
 * 没登记的种类只给「单一」：别的策略要有多个账号才有用，而多账号是各家
 * 自己的形态（开放平台一把 key 一个租户，中转站一个账号一个钱包）。
 *
 * 兜底只在这里一份：注册表里漏填 policies 的种类从这里过一遍，别处不再
 * 自己写一遍默认策略。
 */
export function policiesOfKind(kind: string): ProviderPolicy[] {
  return kindOf(kind)?.policies ?? ["single"];
}

/** 全部种类。 */
export function allKinds(): ProviderKind[] {
  return [...REGISTRY.values()];
}

/**
 * 面板上能选的类型。
 *
 * The panel asks; it does not keep a list of its own.
 */
export function selectableKinds(): {
  kind: string;
  label: string;
  login: ProviderLoginMethod;
  needsRegion: boolean;
  regions: string[];
  policies: ProviderPolicy[];
}[] {
  return allKinds().map((k) => ({
    kind: k.kind,
    label: k.label,
    login: k.login,
    needsRegion: k.needsRegion ?? false,
    regions: k.regions ?? [],
    policies: policiesOfKind(k.kind),
  }));
}
