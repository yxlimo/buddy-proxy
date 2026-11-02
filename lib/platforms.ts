// lib/platforms.ts — 平台：代码里的模板，加上表里的开放平台。
//
// 一个平台是一个服务，不是一份登录：Qoder 的全球区与中国区是两个平台。
//
// 平台的 id 就是请求路径里那一段（`/minimax/v1/messages`），所以它是契约的
// 一部分，改名等于把调用方的 base_url 打断。
//
// 平台有两处数据源：这里的模板（PLATFORMS）与表里的开放平台
// （lib/open-platforms.ts）。模板优先：id 撞了算模板的 —— 把模板加回代码时
// 不用先清库，回滚是安全的。
//
// 账号不在这里：账号是 provider 表里的行，同一个平台下可以有多行。平台说
// 「怎么说话」（kind）、「在哪个区域」、「支持哪些选账号的策略」；账号说
// 「用哪份登录」。

import { store } from "./store.ts";
import { PROVIDER_POLICIES, type ProviderPolicy } from "./providers.ts";
import { kindOf } from "./provider-kinds.ts";
import { listOpenPlatforms, openPlatformOf, registerTemplateIds } from "./open-platforms.ts";
// 注册表要有内容，`kindOf` 才答得出「这个平台支持哪几个策略」。这条 import 会
// 绕成 platforms → kinds → … 的环，所以环上任何模块都不能在模块求值期读别人的
// 常量（lib/qoder/benefits.ts 就是为此改成函数内取值的）。
import "./kinds/index.ts";

/** 一个平台：代码里的模板，或者表里的开放平台。 */
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
 * 代码里的模板。
 *
 * The region and the name live with the platform rather than with the account:
 * they are properties of the service, not of who is logged in.
 */
export const PLATFORMS: Platform[] = [
  { id: "minimax", kind: "minimax", label: "MiniMax Code", region: "cn" },
  { id: "qoder", kind: "qoder", label: "Qoder（全球区）", region: "global" },
  { id: "qoder-cn", kind: "qoder", label: "Qoder（中国区）", region: "cn" },
  { id: "workbuddy-cn", kind: "workbuddy", label: "WorkBuddy（中国区）", region: "cn" },
  { id: "workbuddy-global", kind: "workbuddy", label: "WorkBuddy（国际区）", region: "global" },
  { id: "tokenrhythm", kind: "tokenrhythm", label: "TokenRhythm", region: "" },
  { id: "sensenova", kind: "sensenova", label: "SenseNova", region: "" },
  { id: "intern-ai", kind: "intern-ai", label: "书生·端砚", region: "" },
  { id: "qiniu", kind: "qiniu", label: "七牛云", region: "" },
  { id: "xinghuo", kind: "xinghuo", label: "讯飞星火", region: "" },
];

const BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

// 模板的 id 名单交给下面那层：它不引这一层（会成环），但要认得哪些 id 是
// 模板的 —— 表里的开放平台不能跟模板重名。
registerTemplateIds(PLATFORMS.map((p) => p.id));

/**
 * 开放平台的 kind。
 *
 * 还没注册到 kind 注册表里（那件事是后面的阶段）：现在它只是平台列表里的
 * 一行，还接不了请求。
 */
const OPEN_PLATFORM_KIND = "openai";

/**
 * 全部平台：代码里的模板，加上表里的开放平台。
 *
 * 模板在前。id 撞了模板优先 —— 模板里有的 id，表里的那一行当没有。
 */
export function allPlatforms(): Platform[] {
  const extra: Platform[] = [];
  for (const row of listOpenPlatforms()) {
    if (BY_ID.has(row.id)) continue;
    extra.push({ id: row.id, kind: OPEN_PLATFORM_KIND, label: row.label, region: "" });
  }
  return [...PLATFORMS, ...extra];
}

/** 这个 id 是哪个平台：模板优先，然后是表里的开放平台。不认识的 id 就是 null。 */
export function platformOfAny(id: string): Platform | null {
  const template = BY_ID.get(id);
  if (template) return template;
  const row = openPlatformOf(id);
  return row ? { id: row.id, kind: OPEN_PLATFORM_KIND, label: row.label, region: "" } : null;
}

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
