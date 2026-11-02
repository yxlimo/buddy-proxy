// lib/kinds/openai.ts — 开放平台（用户自己加的平台）是什么，写成一段声明。
//
// 开放平台不是代码里的平台，是用户在面板上加的一行：地址、key、模型目录都在
// 表里（lib/open-platforms.ts）。所以这一类上游没有自己的传输层 —— 请求是
// OpenAI 形状原样过去，答案原样回来，鉴权是一把 API key 作 Bearer，与别的
// 开放平台完全一样（lib/router/openai-platform.ts）。
//
// 这一段声明只回答三件事：地址从哪来、key 从哪来、目录里有哪些模型。
//
// 它没有额度接口：额度是那个额度插件的事，还没接。所以这里不实现 quotas /
// outOfCredits / recoverAt —— 面板上「额度未知」不是没钱，是没人问得到。

import { tokenFingerprint } from "../credential.ts";
import { declareNoLoginFlow } from "../login-flow.ts";
import { openPlatformKeyOf } from "../open-platform-credentials.ts";
import { openPlatformOf } from "../open-platforms.ts";
import { OPEN_PLATFORM_KIND_NAME } from "../platforms.ts";
import { fromUpstreamStatus } from "../provider-kinds.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import type { CatalogModel } from "../catalog-models.ts";
import type { ProviderRow } from "../providers.ts";

/**
 * 这个平台的模型目录。
 *
 * 目录是**平台**的，不是账号的：同一个平台下两个账号服务同一批模型。所以目录
 * 从平台那一行取，账号只决定谁来付钱。
 *
 * 目录只给名字：上游没报上下文长度与能力，那几项就不写 —— 填一个猜的数等于
 * 对客户端撒谎（客户端会拿它当承诺）。
 */
function openPlatformCatalogModels(provider: ProviderRow): CatalogModel[] {
  const items = openPlatformOf(provider.platform)?.models.items ?? [];
  return items.map((id) => ({ id, displayName: id, reasoning: false, toolCall: false }));
}

/**
 * 面板上看到的凭据状态。
 *
 * 干活的是那把 key：没有它，一个请求也发不出去。所以状态只看它。
 */
function openPlatformStatus(provider: ProviderRow): Record<string, unknown> {
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

export const openaiKind = registerCompatiblePlatform({
  kind: OPEN_PLATFORM_KIND_NAME,
  label: "开放平台（OpenAI 兼容）",
  // 面板上填一把 key 就行：没有登录这一说。
  login: "api_key",
  // 那一把 key 既是推理凭据，也是这个账号唯一的凭据。
  inferWith: "api_key",
  // 地址是表里那一行的。拿不到时返回空串，不抛：抛出去会让「平台列表」这类
  // 只读路径也炸，而转发层自己会报「地址不对」。
  baseUrl: (provider) => openPlatformOf(provider.platform)?.baseUrl ?? "",
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => openPlatformKeyOf(accountId ?? provider.id)?.apiKey ?? "",
  credential: (provider) => fromUpstreamStatus(openPlatformStatus(provider), "api_key"),
  models: openPlatformCatalogModels,
});

// 只有一把 API Key：没有会话，也没有额度接口要登。
declareNoLoginFlow(OPEN_PLATFORM_KIND_NAME, "开放平台用 API Key，没有会话登录");
