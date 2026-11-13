// lib/xinghuo/register.ts — 讯飞星火是什么，写成一段声明。
//
// 转发是所有开放平台共用的（lib/router/openai-platform.ts）：请求是 OpenAI
// 形状原样过去，答案原样回来，鉴权是一把 API key 作 Bearer。
// 星火剩下的只有三件事：地址、key 从哪来、模型有哪些。
//
// 它没有额度接口：面板上「额度未知」不是没钱，是没人问得到。所以这里不实现
// quotas / outOfCredits / recoverAt。

import { fromUpstreamStatus } from "../provider-kinds.ts";
import { providerSecretId } from "../credential-ids.ts";
import { keyPlan, secretRecord, valueSlot } from "../kinds/shared.ts";
import { catalogModelsFromRow } from "../catalog-models.ts";
import { declareNoLoginFlow } from "../login-flow.ts";
import { declareNoQuotaPlugin } from "../quota-plugins.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { xinghuoInferenceKey, xinghuoStatus, writeXinghuoKey } from "./account.ts";
import { XINGHUO_INFER_BASE } from "./config.ts";
import { XINGHUO_MODELS, xinghuoCatalogModels } from "./models.ts";

/**
 * 代码里那一份目录：元数据表的出处。
 *
 * 星火的 /v2/models 报得出来，但参数一个也不带（只有 id / object / created /
 * owned_by / permission / root）：上下文长度与输出上限只有这张表里有。所以行里
 * 的 id 去这里查，行里自己记着的参数优先。
 */
const CODE_CATALOG = xinghuoCatalogModels(XINGHUO_MODELS);
const CODE_BY_ID = new Map(CODE_CATALOG.map((model) => [model.id, model]));

export const xinghuoKind = registerCompatiblePlatform({
  kind: "xinghuo",
  label: "讯飞星火",
  // 面板上填一把 key 就行：没有登录这一说。
  login: "api_key",
  baseUrl: () => XINGHUO_INFER_BASE,
  // 这一类默认指哪台（地址是适配器自己的能力描述，不是平台清单）。
  defaultBaseUrl: XINGHUO_INFER_BASE,
  // 只有这一把 key：它既是推理凭据，也是这个账号唯一的凭据。
  inferWith: "api_key",
  // 一段凭据：推理 key。星火没有额度接口，所以没有第二段可列。
  credentials: keyPlan({
    title: "讯飞星火 API Key",
    slots: () => [
      valueSlot({
        label: "推理 Key",
        form: "api_key",
        id: (account) => providerSecretId(account.id, "account"),
        value: (account) => xinghuoInferenceKey(account.id),
        updatedAt: (account) =>
          secretRecord(providerSecretId(account.id, "account")).updatedAt,
      }),
    ],
    field: {
      name: "api-key",
      label: "推理 Key",
      hint: "在讯飞星火控制台创建的推理 key，整串粘贴",
      placeholder: "在讯飞星火控制台复制的 API Key",
    },
    write: (account, value) => writeXinghuoKey(account.id, value),
  }),
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => xinghuoInferenceKey(accountId ?? provider.id),
  credential: (provider) => fromUpstreamStatus(xinghuoStatus(provider.id), "api_key"),
  // 目录是平台那一行说了算：行里的 id 与顺序就是公布的，元数据去代码表里查
  // （行里记着的参数优先）。行读不到不退回代码目录：目录归上游之后，代码表只剩
  // 「按 id 取元数据」这一个用途，拿它当目录会把上游没报的模型报出去。
  models: (provider) => catalogModelsFromRow(provider, () => [], (id) => CODE_BY_ID.get(id)),
});

// 只有一把 API Key：没有会话，也没有额度接口要登。
declareNoLoginFlow("xinghuo", "星火用 API Key，没有会话登录");

// 星火没有额度接口：面板上那一格写的是「未知」，不是 0 —— 上游没有额度可问，
// 说成 0 就是拿「没钱」去顶「没人问得到」。
declareNoQuotaPlugin("xinghuo", "星火没有额度接口，面板上只能显示「未知」");

