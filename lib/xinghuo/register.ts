// lib/xinghuo/register.ts — 讯飞星火是什么，写成一段声明。
//
// 转发是所有开放平台共用的（lib/router/openai-platform.ts）：请求是 OpenAI
// 形状原样过去，答案原样回来，鉴权是一把 API key 作 Bearer。
// 星火剩下的只有三件事：地址、key 从哪来、模型有哪些。
//
// 它没有额度接口：面板上「额度未知」不是没钱，是没人问得到。所以这里不实现
// quotas / outOfCredits / recoverAt。

import { fromUpstreamStatus } from "../provider-kinds.ts";
import { declareNoLoginFlow } from "../login-flow.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { xinghuoInferenceKey, xinghuoStatus } from "./account.ts";
import { XINGHUO_INFER_BASE } from "./config.ts";
import { XINGHUO_MODELS, xinghuoCatalogModels } from "./models.ts";

export const xinghuoKind = registerCompatiblePlatform({
  kind: "xinghuo",
  label: "讯飞星火",
  // 面板上填一把 key 就行：没有登录这一说。
  login: "api_key",
  baseUrl: () => XINGHUO_INFER_BASE,
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => xinghuoInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(xinghuoStatus(provider.id), "api_key"),
  // 目录写死：星火没有可查的模型目录接口。
  models: () => xinghuoCatalogModels(XINGHUO_MODELS),
});

// 只有一把 API Key：没有会话，也没有额度接口要登。
declareNoLoginFlow("xinghuo", "星火用 API Key，没有会话登录");
