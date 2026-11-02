// lib/platforms.ts — 平台：代码里的模板，加上表里的开放平台。
//
// 一个平台是一个服务，不是一份登录：Qoder 的全球区与中国区是两个平台。
//
// 平台的 id 就是请求路径里那一段（`/minimax/v1/messages`），所以它是契约的
// 一部分，改名等于把调用方的 base_url 打断。
//
// 平台有两处数据源：模板（lib/platform-templates.ts 里的 PLATFORMS）与表里
// 的开放平台（lib/open-platforms.ts）。模板优先：id 撞了算模板的 —— 把模板
// 加回代码时不用先清库，回滚是安全的。
//
// 账号不在这里：账号是 provider 表里的行，同一个平台下可以有多行。平台说
// 「怎么说话」（kind）、「在哪个区域」、「支持哪些选账号的策略」；账号说
// 「用哪份登录」。

import { store } from "./store.ts";
import { PROVIDER_POLICIES, type ProviderPolicy } from "./providers.ts";
import { kindOf } from "./provider-kinds.ts";
import { listOpenPlatforms, openPlatformOf, OPEN_PLATFORM_KIND_NAME } from "./open-platforms.ts";
import { PLATFORMS, type Platform } from "./platform-templates.ts";
// 注册表要有内容，`kindOf` 才答得出「这个平台支持哪几个策略」。这条 import 会
// 绕成 platforms → kinds → … 的环，所以环上任何模块都不能在模块求值期读别人的
// 常量（lib/qoder/benefits.ts 就是为此改成函数内取值的）。
import "./kinds/index.ts";

// 模板住在叶子模块里（lib/platform-templates.ts）：表里的开放平台也要认得
// 模板的 id 名单，而它不引这一层（会成环）。这里转出去，调用方的 import
// 不用改。
export { PLATFORMS };
export type { Platform };

// 开放平台的 kind 名字住在 lib/open-platforms.ts（那一层不引这一层，环上读它
// 的常量不会踩到求值顺序）。这里转出去：调用方的 import 不用改。
export { OPEN_PLATFORM_KIND_NAME };

const BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

/**
 * 已经报过「跟代码里的模板重名」的那些 id。
 *
 * allPlatforms() 在每个 /v1/models 请求里都会被调一次：按请求频率报同一个配置
 * 错误，会把真正的故障淹掉。这是配置错误，一个进程一个 id 说一次就够。
 */
const warnedDuplicateIds = new Set<string>();

/**
 * 全部平台：代码里的模板，加上表里的开放平台。
 *
 * 模板在前。id 撞了模板优先 —— 模板里有的 id，表里的那一行当没有。
 */
export function allPlatforms(): Platform[] {
  const extra: Platform[] = [];
  for (const row of listOpenPlatforms()) {
    if (BY_ID.has(row.id)) {
      // 模板优先：表里这一行当没有。说一声是哪一行不生效 —— 不然表里躺着
      // 一行死平台，没人数得清它为什么不见了。一个 id 一个进程只说一次：
      // 这行告警的频率不该跟着请求频率走。
      if (!warnedDuplicateIds.has(row.id)) {
        warnedDuplicateIds.add(row.id);
        console.warn(`[PLATFORM] 表里的 ${row.id} 跟代码里的模板重名，这一行不生效`);
      }
      continue;
    }
    extra.push({ id: row.id, kind: OPEN_PLATFORM_KIND_NAME, label: row.label, region: "" });
  }
  return [...PLATFORMS, ...extra];
}

/** 这个 id 是哪个平台：模板优先，然后是表里的开放平台。不认识的 id 就是 null。 */
export function platformOfAny(id: string): Platform | null {
  const template = BY_ID.get(id);
  if (template) return template;
  const row = openPlatformOf(id);
  return row ? { id: row.id, kind: OPEN_PLATFORM_KIND_NAME, label: row.label, region: "" } : null;
}

/** 这个 id 是哪个平台。不认识的 id 就是 null。 */
export function platformOf(id: string): Platform | null {
  return BY_ID.get(id) ?? null;
}

/** 哪些平台用的是这一类。 */
export function platformsOfKind(kind: string): Platform[] {
  return PLATFORMS.filter((p) => p.kind === kind);
}

/**
 * 这个 id 是不是一个平台。
 *
 * 模板或表里的开放平台都算：两处数据源都是平台。
 */
export function isPlatform(id: string): boolean {
  return platformOfAny(id) !== null;
}

/**
 * 这个平台支持哪些选账号的策略。
 *
 * 注册表说一类上游支持什么，平台照搬；没登记的只给单一。
 *
 * 平台有两处数据源（模板与表里的开放平台），两处都认：开放平台的 kind 登记了
 * 「单一 / 降级」，只认模板的话它会被说成只支持单一。
 */
export function platformPolicies(platform: string): ProviderPolicy[] {
  const p = platformOfAny(platform);
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
  // 平台有两处数据源：模板与表里的开放平台。只认模板的话，开放平台的策略
  // 改不了（面板会说「没有这个平台」）。
  const known = platformOfAny(platform);
  if (!known) return { ok: false, message: `没有这个平台：${platform}` };
  const supported = platformPolicies(platform);
  if (!supported.includes(policy)) {
    const names = supported.map((p) => `${POLICY_TEXT[p] ?? p}（${p}）`).join("、");
    return {
      ok: false,
      message: `${known.label} 不支持这个策略，它只支持：${names}。`,
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

/**
 * 忘掉这个平台的生效策略。
 *
 * 平台没了，那一行就是一根没人认的指针：下次用同一个 id 建回来，它会凭空
 * 继承旧策略。没有行就是默认（单一），所以删掉是对的。
 */
export function forgetPlatformPolicy(platform: string): void {
  store().prepare("DELETE FROM platform_policy WHERE platform = ?").run(platform);
}

/** 给人看的策略名。 */
export const POLICY_TEXT: Record<string, string> = {
  single: "单一",
  fallback: "降级",
  expiry_first: "余额到期优先",
};
