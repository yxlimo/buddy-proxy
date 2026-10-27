// lib/router/compatible-platform.ts — 声明式登记一个开放平台。
//
// 开放平台只有三件事各不相同：地址、key 从哪来、额度怎么问。方言翻译在
// lib/dialect/，转发在 lib/router/openai-platform.ts —— 那些是所有开放平台
// 共用的，不该每接一个平台重写一遍。
//
// 所以接一个平台的成本应该是一段声明，而不是五个文件。

import type Koa from "koa";
import type { Json } from "../json.ts";
import { provider as providerRow, type ProviderRow } from "../providers.ts";
import {
  fromUpstreamStatus,
  registerKind,
  type CredentialView,
  type HealthSnapshot,
  type ProviderKind,
  type QuotaView,
} from "../provider-kinds.ts";
import type { CatalogModel } from "../catalog-models.ts";
import type { Dialect } from "./deliver.ts";
import type { Route } from "./routes.ts";
import { openAiPlatformChat } from "./openai-platform.ts";
import { toOpenAiPlatform, type UpstreamContext } from "./upstreams.ts";

/** 一个「OpenAI 方言、key 鉴权、原样透传」的平台。 */
export interface CompatiblePlatform {
  /** provider 表里的 kind。 */
  kind: string;
  /** 面板上显示的名字。 */
  label: string;
  /**
   * 上游报错时在提示里怎么称呼它。默认就是 `label`。
   *
   * 留这一项是因为提示里的名字与面板上的名字可以不一样（原来是「SenseNova 」
   * 带一个空格），改掉会让日志里那句话变样。
   */
  what?: string;
  /** 登录办法。key 类平台通常是 "api_key"。 */
  login: ProviderKind["login"];
  /** 要不要区域。 */
  needsRegion?: boolean;
  /** 支持的生效策略。默认 ["single", "fallback"]。 */
  policies?: ProviderKind["policies"];
  /** 推理端点的基础地址（`/chat/completions` 由工厂接上）。 */
  baseUrl(provider: ProviderRow): string;
  /**
   * 这个账号推理用的 key。空字符串表示没有。
   *
   * 第二个参数是策略选中的那个账号：一个平台下有多个账号，key 是按账号取
   * 的，而 `provider` 只说明是哪个平台。
   */
  keyOf(provider: ProviderRow, accountId?: string): string;
  /** 模型目录。 */
  models(provider: ProviderRow): CatalogModel[];
  /** 额度视图。不给就是没有。 */
  quotas?(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[];
  /** 额度用尽了吗。不给就是不知道（false）。 */
  outOfCredits?(provider: ProviderRow, snapshot: HealthSnapshot): boolean;
  /** 凭据状态。不给就按 key 类的默认来。 */
  credential?(provider: ProviderRow): CredentialView;
}

/**
 * 登记一个开放平台。
 *
 * 生成的那个种类自带 dispatch：请求怎么发出去由工厂说，`router-proxy.ts`
 * 不再为它写一个 case。
 */
export function registerCompatiblePlatform(platform: CompatiblePlatform): ProviderKind {
  const kind: ProviderKind = {
    kind: platform.kind,
    label: platform.label,
    login: platform.login,
    needsRegion: platform.needsRegion,
    // 平台直接转发：agent 写的请求原样过去，会话相关的头也跟着过去。
    openPlatform: true,
    policies: platform.policies ?? ["single", "fallback"],
    baseUrl: platform.baseUrl,
    credential: platform.credential ?? (() => missingCredential()),
    models: platform.models,
    quotas: platform.quotas ?? (() => []),
    outOfCredits: platform.outOfCredits ?? (() => false),
    dispatch: (ctx, body, route, dialect, stream, out) =>
      toOpenAiPlatform(ctx, body, route, dialect, stream, out, {
        log: platform.kind,
        what: platform.what ?? platform.label,
        chat: (openaiBody, headers, accountId) => {
          const row = rowOf(accountId, platform.kind, route.platform);
          return openAiPlatformChat(
            {
              id: platform.kind,
              label: platform.label,
              base: platform.baseUrl(row),
              key: platform.keyOf(row, accountId),
            },
            openaiBody,
            headers,
          );
        },
      }),
  };
  registerKind(kind);
  return kind;
}

/**
 * 策略选中了哪个账号，就是那一行。
 *
 * 行可能已经不在了（请求在路上时账号被删），那就只拿 id 拼一个：地址与 key
 * 都是从账号上取的，取不到 key 会报「账号上没有推理用的 API key」，比在这里
 * 抛一个空指针清楚。
 */
function rowOf(accountId: string, kind: string, platform: string): ProviderRow {
  const known = providerRow(accountId);
  if (known) return known;
  return {
    id: accountId,
    platform,
    kind,
    region: "",
    alias: "",
    enabled: true,
    weight: 0,
    policy: "single",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 没给凭据钩子的平台：不知道，也没配。 */
function missingCredential(): CredentialView {
  return fromUpstreamStatus({ status: "missing" }, "api_key");
}

/** 一次转发。`ProviderKind.dispatch` 的形状。 */
export type KindDispatch = (
  ctx: UpstreamContext,
  body: Json,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  out: Koa.Context,
) => Promise<void>;
