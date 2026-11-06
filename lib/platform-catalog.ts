// lib/platform-catalog.ts — 平台模板表：还没迁进开放平台表的那几个。
//
// 另有一张「能建的平台种类」表（PLATFORM_KIND_OPTIONS）在后面：面板新增平台时
// 的下拉，收的是**方言**（向上游讲谁的格式），不是厂商，也不是预置了哪几行。
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
 * 一个模拟客户端的平台：向上游冒充那个封闭客户端的这一族。
 *
 * 一条 = 一个**平台**，不是一条 = 一个客户端：Qoder 的全球区与中国区是同一
 * 个客户端的两个平台，id、区域、名下的账号都分开。
 *
 * 它们曾经是代码里的平台模板（lib/platform-templates.ts 的 PLATFORMS），现在改成
 * 表里的行：启动时按这张目录播种（lib/store.ts 的 migrateSimulatedClients）。
 */
export interface SimulatedClientPreset {
  /** 目录自己的键。 */
  key: string;
  /** 平台 id：请求路径里那一段，建行时就用它，不给用户改。 */
  id: string;
  /** 面板上显示的名字。 */
  label: string;
  /** kind 注册表里的那一类。 */
  kind: string;
  /** 区域（空串 = 没有）。 */
  region: string;
  /** 面板上给不给建（false = 目录里先备着，启动时不播种）。 */
  hidden: boolean;
}

/**
 * 预置的模拟客户端平台。
 *
 * 播种照这张表走，所以 `hidden === false` 的每一行都是「表里必有的一行」：id 与
 * label 是那几个平台的身份，改了就是改调用方的 base_url。
 *
 * `hidden: true` 的那一条**不播种**（ZCode 的会话还没接完）：播出来就是一个地址、
 * 目录、额度全空的平台，面板上看得见却用不了。条目留着，将来放开只改这一个布尔，
 * 下一次启动就播。
 */
export const SIMULATED_CLIENTS: readonly SimulatedClientPreset[] = [
  { key: "minimax", id: "minimax", label: "MiniMax Code", kind: "minimax", region: "cn", hidden: false },
  { key: "qoder-global", id: "qoder", label: "Qoder（全球区）", kind: "qoder", region: "global", hidden: false },
  { key: "qoder-cn", id: "qoder-cn", label: "Qoder（中国区）", kind: "qoder", region: "cn", hidden: false },
  { key: "workbuddy-cn", id: "workbuddy-cn", label: "WorkBuddy（中国区）", kind: "workbuddy", region: "cn", hidden: false },
  { key: "workbuddy-global", id: "workbuddy-global", label: "WorkBuddy（国际区）", kind: "workbuddy", region: "global", hidden: false },
  { key: "zcode", id: "zcode", label: "ZCode", kind: "zcode", region: "", hidden: true },
];

/**
 * 这个 kind 是不是模拟客户端那一族。
 *
 * 平台全在表里之后，「模拟客户端」与「开放平台」只剩 kind 能分：两者的行长得
 * 一样，区别在谁维护地址与目录 —— 前者是代码里的模拟端，后者是用户填的地址。
 * 判别只写这一处：拉目录、面板报那几格、凭据形状都问它，各写一遍早晚会漂成
 * 「一处拦住了、另一处还在每五分钟拿真 key 打一次上游」。
 */
export function isSimulatedClientKind(kind: string): boolean {
  return SIMULATED_CLIENTS.some((client) => client.kind === kind);
}

/** 这个 id 是不是预置的模拟客户端平台（含 hidden 那一条）。 */
export function isSimulatedClientId(id: string): boolean {
  return SIMULATED_CLIENTS.some((client) => client.id === id);
}

/**
 * 面板上看得见、也建得了的那几条模拟客户端（hidden 的除外）。
 *
 * hidden 是「目录里先备着、面板上还不给」的那一条：它在建行时被跳过。读目录
 * 只认这一份，别自己再按 hidden 过一遍 —— 过法不一致就会出现「面板上选了它、
 * 建的时候说没有这一类」。
 */
export function visibleSimulatedClients(): SimulatedClientPreset[] {
  return SIMULATED_CLIENTS.filter((client) => !client.hidden);
}

/**
 * 这个 kind 名下能建的那几条预置。
 *
 * 一个 kind 可能对应不止一个平台（Qoder 的全球区与中国区都是 qoder），所以这里
 * 返回的是列表，由调用方拿 id 挑；不是逐一对应的地方别拿它当唯一性判断。
 */
export function simulatedClientPresetsOfKind(kind: string): SimulatedClientPreset[] {
  return visibleSimulatedClients().filter((client) => client.kind === kind);
}

/**
 * 这个 kind 是不是本仓预置的那五家厂商模板。
 *
 * 它们的模型目录是**代码挑过的一份**（lib/qiniu/models.ts 这些常量表），不是
 * 上游报什么就收什么：上游那份更宽（七牛报 78 个模型，比我们分组的那份宽），
 * 盖上来会出现被上游拒的模型。所以这一类平台的目录不归自动拉管。
 */
export function isVendorTemplateKind(kind: string): boolean {
  return PLATFORM_TEMPLATES.some((t) => t.kind === kind);
}

/**
 * 用户能自己建的一类平台：面板上「新增平台」的那个下拉，一格一条。
 *
 * 与模板表的分工：模板表说的是「代码里预置了哪些平台行」，这一张说的是
 * 「用户能建哪几种」。两者不重叠 —— 这一张收的是方言，不是厂商。
 */
export interface PlatformKindOption {
  kind: string;
  label: string;
  /** 方言（用户自己加，选的是报文格式）还是预置的模拟客户端（从目录里挑一个）。 */
  category: "dialect" | "simulated";
  /** 预置平台建出来的 id（方言类为空串：id 由用户填）。 */
  presetId: string;
  /** 区域（cn / global / 空串）。方言类为空串。 */
  region: string;
  defaultBaseUrl: string;
  /** 这一类能不能从上游拉模型目录。 */
  modelsFromUpstream: boolean;
}

/**
 * 能建的平台种类，顺序就是面板上下拉的顺序。
 *
 * 只有两种**方言**：向上游讲 OpenAI 格式，还是讲 Anthropic Messages 格式。
 *
 * 厂商那五家（七牛云 / 讯飞星火 / SenseNova / 书生·端砚 / TokenRhythm）
 * **不在这里**：它们是本仓预置的平台模板（上面那张表，迁移补出来的库行），各自
 * kind 已经体现了协议差异 —— 用户加一个同类账号要的是「往这个地址讲这个方言」，
 * 不是建一个新厂商。模拟客户端那五家（minimax / qoder / qoder-cn /
 * workbuddy-cn / workbuddy-global）同理不在：一个客户端一份会话，靠登录拿凭据，
 * 建出来的空平台没有模拟端可用。
 *
 * 两类都没有默认地址：一个讲 OpenAI、一个讲 Anthropic Messages，哪家中转站、
 * 哪个自建服务，只有用户知道。
 *
 * 那两个 `modelsFromUpstream` 与 kinds 登记表同源（ProviderKind.modelsFromUpstream）：
 * 这一格只是新建下拉里的一列，事实在登记表那边。改一处就要改另一处。
 */
export const PLATFORM_KIND_OPTIONS: readonly PlatformKindOption[] = [
  {
    kind: "openai",
    label: "OpenAI 兼容",
    category: "dialect",
    presetId: "",
    region: "",
    defaultBaseUrl: "",
    modelsFromUpstream: true,
  },
  {
    kind: "anthropic",
    label: "Anthropic 兼容",
    category: "dialect",
    presetId: "",
    region: "",
    defaultBaseUrl: "",
    modelsFromUpstream: true,
  },
];

/** 能建的这一类平台。认不出就是 null（不能建的那种）。 */
export function platformKindOptionOf(kind: string): PlatformKindOption | null {
  return PLATFORM_KIND_OPTIONS.find((option) => option.kind === kind) ?? null;
}

/**
 * 面板上「新增平台」那一屏能选的全部：先方言，再模拟客户端。
 *
 * 两族分开报（category）：方言类要用户填 id 与地址，模拟客户端类的 id、地址、
 * 区域都由预置定死 —— 面板按这一格决定问不问那两格。hidden 的那几条不出现，
 * 它们连建都不给建。
 *
 * 顺序是契约的一部分：面板照答案渲染，不自己排。
 */
export function platformKindChoices(): PlatformKindOption[] {
  const simulated: PlatformKindOption[] = visibleSimulatedClients().map((client) => ({
    kind: client.kind,
    label: client.label,
    category: "simulated",
    presetId: client.id,
    region: client.region,
    // 地址由模拟端定，面板不问也不显示。
    defaultBaseUrl: "",
    // 模拟客户端的目录是代码挑过的一份，不让上游覆盖。
    modelsFromUpstream: false,
  }));
  return [...PLATFORM_KIND_OPTIONS, ...simulated];
}
