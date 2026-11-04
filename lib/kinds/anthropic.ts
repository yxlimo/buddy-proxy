// lib/kinds/anthropic.ts — 上游讲 Anthropic Messages 的那一类开放平台。
//
// 与 openai 那一类（lib/kinds/openai.ts）只差报文形状：上游收 Anthropic 的
// Messages、答 Anthropic 的 Messages，鉴权按 Anthropic 的约定（x-api-key 加
// anthropic-version），不是 Bearer。地址、key 与目录仍然是平台那一行的事。
//
// 为什么不用 registerCompatiblePlatform：那个工厂的 dispatch 写死了 OpenAI 方言
// （请求原样发、答案原样回）。这里的 dispatch 是 toAnthropicPlatform
// （lib/router/upstreams/open-platform.ts），方言转换在转发层里。

import { tokenFingerprint } from "../credential.ts";
import { declareNoLoginFlow } from "../login-flow.ts";
import { openPlatformKeyOf } from "../open-platform-credentials.ts";
import { openPlatformOf } from "../open-platforms.ts";
import { fromUpstreamStatus, registerKind } from "../provider-kinds.ts";
import { declareNoQuotaPlugin } from "../quota-plugins.ts";
import { anthropicPlatformChat, ANTHROPIC_VERSION, toAnthropicPlatform } from "../router/upstreams/open-platform.ts";
import type { ProviderRow } from "../providers.ts";

/**
 * 这一类平台的 kind 名字。
 *
 * 与 openai 一样住在 kind 这一层（不放进 lib/open-platforms.ts）：那边的常量
 * 是「通用的那一类」的名字，而这一类是另一个适配器。面板能建哪几类由
 * lib/platform-catalog.ts 的 PLATFORM_KIND_OPTIONS 说，两处各说各的事。
 */
export const ANTHROPIC_PLATFORM_KIND_NAME = "anthropic";

/**
 * 面板上看到的凭据状态。
 *
 * 干活的是那把 key：没有它，一个请求也发不出去。所以状态只看它。
 */
function anthropicStatus(provider: ProviderRow): Record<string, unknown> {
  const key = openPlatformKeyOf(provider.id);
  return {
    status: key ? "usable" : "missing",
    fingerprint: key ? tokenFingerprint(key.apiKey) : "",
    expiresAt: "",
    remainingSec: 0,
    warning: false,
    detail: key ? "有推理用的 API key" : "账号上没有推理用的 API key",
  };
}

registerKind({
  kind: ANTHROPIC_PLATFORM_KIND_NAME,
  label: "Anthropic 兼容",
  // 面板上填一把 key 就行：没有登录这一说。
  login: "api_key",
  // 两个方言的平台都是直接转发：agent 写的请求过去，会话头也跟着过去。
  openPlatform: true,
  policies: ["single", "fallback"],
  // 地址是表里那一行的。拿不到时返回空串，不抛：抛出去会让「平台列表」这类
  // 只读路径也炸（与 openai 那一类同一个取法）。
  baseUrl: (provider) => openPlatformOf(provider.platform)?.baseUrl ?? "",
  // 那一把 key 既是推理凭据，也是这个账号唯一的凭据。
  inferWith: "api_key",
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => openPlatformKeyOf(accountId ?? provider.id)?.apiKey ?? "",
  // 问目录跟推理一个口径：这一类上游不认 Bearer，只认 x-api-key 加版本头。
  catalogAuth: (key) => ({ "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }),
  credential: (provider) => fromUpstreamStatus(anthropicStatus(provider), "api_key"),
  // 目录是平台的（表里那一行），不在这里写死。平台行上的那一份怎么播种是另一件
  // 事 —— 这里返回空数组说的是「这一层没有额外的目录」，不是「这个平台没有模型」：
  // 面板上发布的模型会作为声明补进目录（lib/admin/platform-state.ts）。
  models: () => [],
  // 没有额度接口：问不到就是「不知道」，不是 0。
  quotas: () => [],
  outOfCredits: () => false,
  dispatch: (ctx, body, route, dialect, stream, out) =>
    toAnthropicPlatform(ctx, body, route, dialect, stream, out, {
      log: ANTHROPIC_PLATFORM_KIND_NAME,
      what: "Anthropic 兼容平台",
      chat: (anthropicBody, headers, accountId) =>
        anthropicPlatformChat(
          {
            id: ANTHROPIC_PLATFORM_KIND_NAME,
            label: "Anthropic 兼容平台",
            base: openPlatformOf(route.platform)?.baseUrl ?? "",
            key: openPlatformKeyOf(accountId)?.apiKey ?? "",
          },
          anthropicBody,
          headers,
        ),
    }),
});

// 只有一把 API Key：没有会话，也没有额度接口要登。
declareNoLoginFlow(ANTHROPIC_PLATFORM_KIND_NAME, "Anthropic 兼容平台用 API Key，没有会话登录");

// 这一类没有额度接口：面板上那一格写的是「未知」，不是 0 —— 上游没有额度可问，
// 说成 0 就是拿「没钱」去顶「没人问得到」。
declareNoQuotaPlugin(ANTHROPIC_PLATFORM_KIND_NAME, "Anthropic 兼容平台没有额度接口，面板上只能显示「未知」");
