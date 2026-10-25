// lib/platforms.ts — 平台：代码里写死的模板。
//
// 一个平台是一个服务，不是一份登录：Qoder 的全球区与中国区是两个平台，
// MiniMax Code 与 MiniMax 开放平台也是两个。
//
// 平台的 id 就是请求路径里那一段（`/minimax/v1/messages`），所以它是契约的
// 一部分，改名等于把调用方的 base_url 打断。新增一个平台只在代码里加一条。
//
// 账号不在这里：账号是 provider 表里的行，同一个平台下可以有多行。平台说
// 「怎么说话」（kind）、「在哪个区域」、「支持哪些选账号的策略」；账号说
// 「用哪份登录」。

import { store } from "./store.ts";
import { PROVIDER_POLICIES, type ProviderPolicy } from "./providers.ts";
import { kindOf } from "./provider-kinds.ts";
// 注册表要有内容，`kindOf` 才答得出「这个平台支持哪几个策略」。这条 import 会
// 绕成 platforms → kinds → … 的环，所以环上任何模块都不能在模块求值期读别人的
// 常量（lib/qoder/benefits.ts 就是为此改成函数内取值的）。
import "./kinds.ts";

/** 一个平台：代码里的模板。 */
export interface Platform {
  /** 路径里那一段。改它等于打断调用方。 */
  id: string;
  /** 怎么跟它说话 —— 也就是 kind 注册表里的那一类。 */
  kind: string;
  /** 面板上给人看的名字。 */
  label: string;
  /** 区域：cn / global / 空。 */
  region: string;
}

/**
 * 九个平台。
 *
 * The region and the name live with the platform rather than with the account:
 * they are properties of the service, not of who is logged in.
 */
export const PLATFORMS: Platform[] = [
  { id: "minimax", kind: "minimax", label: "MiniMax Code", region: "cn" },
  { id: "minimax-api", kind: "minimax-api", label: "MiniMax 开放平台", region: "cn" },
  { id: "zcode", kind: "zcode", label: "ZCode", region: "cn" },
  { id: "qoder", kind: "qoder", label: "Qoder（全球区）", region: "global" },
  { id: "qoder-cn", kind: "qoder", label: "Qoder（中国区）", region: "cn" },
  { id: "workbuddy-cn", kind: "workbuddy", label: "WorkBuddy（中国区）", region: "cn" },
  { id: "tokenrhythm", kind: "tokenrhythm", label: "TokenRhythm", region: "" },
  { id: "sensenova", kind: "sensenova", label: "SenseNova", region: "" },
  { id: "intern-ai", kind: "intern-ai", label: "书生·端砚", region: "" },
];

const BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

/** 这个 id 是哪个平台。不认识的 id 就是 null。 */
export function platformOf(id: string): Platform | null {
  return BY_ID.get(id) ?? null;
}

/** 哪些平台用的是这一类。 */
export function platformsOfKind(kind: string): Platform[] {
  return PLATFORMS.filter((p) => p.kind === kind);
}

/** 这个 id 是不是一个平台。 */
export function isPlatform(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * 这个平台支持哪些选账号的策略。
 *
 * 注册表说一类上游支持什么，平台照搬；没登记的只给单一。
 */
export function platformPolicies(platform: string): ProviderPolicy[] {
  const p = platformOf(platform);
  if (!p) return ["single"];
  const policies = kindOf(p.kind)?.policies;
  return policies && policies.length ? policies : ["single"];
}

/* ------------------------------------------------------------------ *
 * 生效策略
 * ------------------------------------------------------------------ */

/**
 * 这个平台的生效策略。
 *
 * 策略是平台的事，不是账号的事：它说的是「这个平台下的几个账号怎么选」，
 * 而一个账号自己没法决定要不要退到另一个账号。
 */
export function platformPolicy(platform: string): ProviderPolicy {
  const row = store()
    .prepare("SELECT policy FROM platform_policy WHERE platform = ?")
    .get(platform) as { policy?: string } | undefined;
  const value = String(row?.policy ?? "");
  // 读回来的是存着的那个值，不按「这个平台支持哪几个」筛：支持不支持是写入
  // 时的事，读的时候筛会把旧库里的策略悄悄降级成单一（注册表还没加载时尤其
  // 明显）。
  return (PROVIDER_POLICIES as string[]).includes(value) ? (value as ProviderPolicy) : "single";
}

/** 改这个平台的生效策略。 */
export function setPlatformPolicy(
  platform: string,
  policy: ProviderPolicy,
): { ok: boolean; message: string } {
  if (!platformOf(platform)) return { ok: false, message: `没有这个平台：${platform}` };
  const supported = platformPolicies(platform);
  if (!supported.includes(policy)) {
    const names = supported.map((p) => `${POLICY_TEXT[p] ?? p}（${p}）`).join("、");
    return {
      ok: false,
      message: `${platformOf(platform)?.label} 不支持这个策略，它只支持：${names}。`,
    };
  }
  store()
    .prepare(
      "INSERT INTO platform_policy (platform, policy, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(platform) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at",
    )
    .run(platform, policy, Date.now());
  return { ok: true, message: `策略改成了${POLICY_TEXT[policy] ?? policy}。` };
}

/** 给人看的策略名。 */
export const POLICY_TEXT: Record<string, string> = {
  single: "单一",
  fallback: "降级",
  expiry_first: "余额到期优先",
};
