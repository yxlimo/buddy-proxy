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
// belongs to (lib/router/upstreams.ts) — one dispatch, not one per question.

import { CredentialState } from "./gen/buddy/admin/v1/admin_pb.ts";
import type { ProviderRow } from "./providers.ts";
import type { CatalogModel } from "./router/catalog.ts";

/** 面板上登录的方式。 */
export type ProviderLoginMethod = "device" | "browser" | "password" | "code";

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
  minimax: Record<string, { balance: unknown; tokenPlan: unknown; credits: unknown }>;
  /** MiniMax 开放平台：每个租户一份套餐额度。 */
  minimaxApi: Record<string, { tenants: unknown }>;
  /** ZCode 的 Start Plan 额度。 */
  zcode: Record<string, { quota: unknown }>;
  workbuddy: Record<string, { credits: unknown }>;
  tokenrhythm: Record<string, { tenants: unknown }>;
  /** SenseNova 的积分池。 */
  sensenova: Record<string, { pools: unknown }>;
  /** 书生·端砚的墨点：余额与批次。 */
  internAi: Record<string, { balance: unknown; packs: unknown }>;
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
   * 是开放 API 平台吗（MiniMax 开放平台、TokenRhythm、SenseNova、书生·端砚）。
   *
   * 平台是直接转发的：agent 写的请求原样过去，会话相关的头也跟着过去。
   * 模拟客户端的那些（Qoder、WorkBuddy、MiniMax Code、ZCode）是按客户端的
   * 样子重建请求的 —— 多余的头直接无视。
   */
  openPlatform?: boolean;
  /** 区域都有哪些。 */
  regions?: string[];
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
}[] {
  return allKinds().map((k) => ({
    kind: k.kind,
    label: k.label,
    login: k.login,
    needsRegion: k.needsRegion ?? false,
    regions: k.regions ?? [],
  }));
}
