// lib/platform-catalog.ts — 平台模板表：还没迁进开放平台表的那几个。
//
// 另有一张「能建的平台种类」表（PLATFORM_KIND_OPTIONS）在后面：面板新增平台时
// 的下拉，说的是能建哪几种，不是预置了哪几行。
//
// 这一层是叶子：不引任何模块。面板与迁移都要引它（引了 store 就成环）。
//
// 地址写的是字面量，不引各平台的 config 那些常量：config 走
// configString（环境能改），引它就把配置读取层拖进来了。这里要的是「新建时
// 填进去的默认地址」，跟各平台 config 的默认值一致 —— 改了那边，这里也要跟着
// 改（每条都注明了出处）。

/** 一个平台模板：还没迁进表里的那种。 */
export interface PlatformTemplate {
  /** 模板自己的键（跟 kind 同名）。 */
  key: string;
  /** 面板上显示的名字。 */
  label: string;
  /** kind 注册表里的那一类：怎么跟它说话。 */
  kind: string;
  /** 推理地址：新建这一行时填进去的默认地址。 */
  defaultBaseUrl: string;
  /** 用户新建时的建议 id。 */
  suggestedId: string;
  /** 额度插件名（空串 = 没有）。 */
  quotaPlugin: string;
  /** 区域（空串 = 没有）。 */
  region: string;
}

/** 还没迁进表里的平台模板。 */
export const PLATFORM_TEMPLATES: PlatformTemplate[] = [
  {
    key: "qiniu",
    label: "七牛云",
    kind: "qiniu",
    // 与 lib/qiniu/config.ts 的 QINIU_INFER_BASE 一致。
    defaultBaseUrl: "https://api.qnaigc.com/v1",
    suggestedId: "qiniu",
    quotaPlugin: "",
    region: "",
  },
  {
    key: "xinghuo",
    label: "讯飞星火",
    kind: "xinghuo",
    // 与 lib/xinghuo/config.ts 的 XINGHUO_INFER_BASE 一致。
    defaultBaseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
    suggestedId: "xinghuo",
    quotaPlugin: "",
    region: "",
  },
  {
    key: "sensenova",
    label: "SenseNova",
    kind: "sensenova",
    // 与 lib/sensenova/config.ts 的 SENSENOVA_INFER_BASE 一致。
    defaultBaseUrl: "https://token.sensenova.cn/v1",
    suggestedId: "sensenova",
    // 积分池在控制台上，问它的插件随 kind 一起登记（lib/sensenova/quota-plugin.ts）。
    quotaPlugin: "sensenova-pools",
    region: "",
  },
  {
    key: "intern-ai",
    label: "书生·端砚",
    kind: "intern-ai",
    // 与 lib/intern-ai/config.ts 的 INTERN_AI_DISCOVERY_API_BASE 一致（端砚
    // 这一侧的推理端点；浦语那一侧是 INTERN_AI_CHAT_API_BASE）。
    defaultBaseUrl: "https://discovery-api.intern-ai.org.cn/v1",
    suggestedId: "intern-ai",
    // 墨点在 Discovery 子站的控制台上（lib/intern-ai/quota-plugin.ts）。
    quotaPlugin: "intern-ai-credits",
    region: "",
  },
  {
    key: "tokenrhythm",
    label: "TokenRhythm",
    kind: "tokenrhythm",
    // 与 lib/tokenrhythm/accounts.ts 的 TOKENRHYTHM_INFER_BASE 一致。
    defaultBaseUrl: "https://tokenrhythm.studio/v1",
    suggestedId: "tokenrhythm",
    // 钱包只能拿会话 cookie 读（lib/tokenrhythm/quota-plugin.ts）。
    quotaPlugin: "tokenrhythm-wallet",
    region: "",
  },
];

/** 模板表里那一个。认不出就是 null。 */
export function platformTemplateOf(key: string): PlatformTemplate | null {
  return PLATFORM_TEMPLATES.find((t) => t.key === key) ?? null;
}

/**
 * 用户能自己建的一类平台：面板上「新增平台」的那个下拉，一格一条。
 *
 * 与模板表的分工：模板表说的是「代码里预置了哪些平台行」，这一张说的是
 * 「用户能建哪几种」。两者有重叠（那五家迁成库行之后既能预置、也能再建一个
 * 同类的账号），但不是一件事 —— 面板要的是 kind 与它的默认值，不是某个 id。
 */
export interface PlatformKindOption {
  kind: string;
  label: string;
  defaultBaseUrl: string;
  /** 这一类能不能从上游拉模型目录。 */
  modelsFromUpstream: boolean;
}

/**
 * 能建的平台种类，顺序就是面板上下拉的顺序。
 *
 * 模拟客户端那五家（minimax / qoder / qoder-cn / workbuddy-cn /
 * workbuddy-global）**不在这里**：它们是一个客户端一份会话，靠登录拿到凭据，
 * 不属于「用户自己加一个」的那一类 —— 建出来的空平台没有模拟端可用，也拉不
 * 到会话。它们照着代码里的模板走（lib/platform-templates.ts）。
 *
 * 地址与名字跟模板表逐字一致（同一个服务，两处说法不该有两样）。这里写成字面
 * 量而不是从模板表算：模板表里可能有一天不再有某一家（迁走了、下线了），而它
 * 仍然是用户能建的一类；反过来也一样。两处走样由 test/open-platforms-check.ts
 * 对着模板表比。
 */
export const PLATFORM_KIND_OPTIONS: readonly PlatformKindOption[] = [
  {
    kind: "openai",
    label: "OpenAI 兼容",
    // 通用平台没有默认地址：哪家中转站、哪个自建服务，只有用户知道。
    defaultBaseUrl: "",
    modelsFromUpstream: true,
  },
  {
    kind: "qiniu",
    label: "七牛云",
    defaultBaseUrl: "https://api.qnaigc.com/v1",
    modelsFromUpstream: true,
  },
  {
    kind: "xinghuo",
    label: "讯飞星火",
    defaultBaseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
    // 它没有模型清单接口：目录只能人写。
    modelsFromUpstream: false,
  },
  {
    kind: "sensenova",
    label: "SenseNova",
    defaultBaseUrl: "https://token.sensenova.cn/v1",
    modelsFromUpstream: true,
  },
  {
    kind: "intern-ai",
    label: "书生·端砚",
    defaultBaseUrl: "https://discovery-api.intern-ai.org.cn/v1",
    modelsFromUpstream: true,
  },
  {
    kind: "tokenrhythm",
    label: "TokenRhythm",
    defaultBaseUrl: "https://tokenrhythm.studio/v1",
    modelsFromUpstream: true,
  },
];

/** 能建的这一类平台。认不出就是 null（不能建的那种）。 */
export function platformKindOptionOf(kind: string): PlatformKindOption | null {
  return PLATFORM_KIND_OPTIONS.find((option) => option.kind === kind) ?? null;
}
