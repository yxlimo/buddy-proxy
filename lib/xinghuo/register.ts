// lib/xinghuo/register.ts — 讯飞星火是什么，写成一段声明。
//
// 转发是所有开放平台共用的（lib/router/openai-platform.ts）：请求是 OpenAI
// 形状原样过去，答案原样回来，鉴权是一把 API key 作 Bearer。
// 星火剩下的只有三件事：地址、key 从哪来、模型有哪些。
//
// 它没有额度接口：面板上「额度未知」不是没钱，是没人问得到。所以这里不实现
// quotas / outOfCredits / recoverAt。

import { fromUpstreamStatus } from "../provider-kinds.ts";
import { catalogModelsFromRow } from "../catalog-models.ts";
import { declareNoLoginFlow } from "../login-flow.ts";
import { declareNoQuotaPlugin } from "../quota-plugins.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { xinghuoInferenceKey, xinghuoStatus } from "./account.ts";
import { XINGHUO_INFER_BASE } from "./config.ts";
import { XINGHUO_MODELS, xinghuoCatalogModels } from "./models.ts";

/**
 * 代码里那一份目录：元数据表的出处，也是行读不到时的兜底。
 *
 * 星火没有可查的模型目录接口，能调的那个写在 lib/xinghuo/models.ts 里。
 */
const CODE_CATALOG = xinghuoCatalogModels(XINGHUO_MODELS);
const CODE_BY_ID = new Map(CODE_CATALOG.map((model) => [model.id, model]));

export const xinghuoKind = registerCompatiblePlatform({
  kind: "xinghuo",
  label: "讯飞星火",
  // 面板上填一把 key 就行：没有登录这一说。
  login: "api_key",
  baseUrl: () => XINGHUO_INFER_BASE,
  // 只有这一把 key：它既是推理凭据，也是这个账号唯一的凭据。
  inferWith: "api_key",
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => xinghuoInferenceKey(accountId ?? provider.id),
  modelsFromUpstream: false,
  credential: (provider) => fromUpstreamStatus(xinghuoStatus(provider.id), "api_key"),
  // 目录是平台那一行说了算：行里的 id 与顺序就是公布的，元数据去代码表里查。
  // 行读不到（模板行本该由迁移补出）才退回代码目录 —— 那是兜底，不是常态。
  models: (provider) => catalogModelsFromRow(provider, () => [...CODE_CATALOG], (id) => CODE_BY_ID.get(id)),
});

// 只有一把 API Key：没有会话，也没有额度接口要登。
declareNoLoginFlow("xinghuo", "星火用 API Key，没有会话登录");

// 星火没有额度接口：面板上那一格写的是「未知」，不是 0 —— 上游没有额度可问，
// 说成 0 就是拿「没钱」去顶「没人问得到」。
declareNoQuotaPlugin("xinghuo", "星火没有额度接口，面板上只能显示「未知」");
