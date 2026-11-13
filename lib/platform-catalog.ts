// lib/platform-catalog.ts — 面板上「能建哪几种平台」与预置的模拟客户端目录。
//
// 这一层是叶子：不引任何模块。面板与迁移都要引它（引了 store 就成环）。
//
// 两张表：
//
//   SIMULATED_CLIENTS     预置的模拟客户端（封闭客户端那一族）。启动时按它把
//                         表里的行播出来（lib/store.ts 的 migrateSimulatedClients）。
//   PLATFORM_KIND_OPTIONS 面板新增平台时的下拉：能建哪几类。
//
// 模板表没了：平台行都是用户在面板上自己建的。区别只是 kind 决定它怎么跟上游
// 说话 —— 方言类（openai / anthropic）讲通用格式。厂商那五家（七牛云 / 讯飞星火
// / SenseNova / 书生·端砚 / TokenRhythm）退场了：存量行由启动时的迁移改成
// openai，它们不再是能新建的一类。
//
// 这一层不引任何模块（引了 store 就成环），所以这里只放 kind 的身份；默认地址
// 与「目录归不归上游」的事实写在 kind 注册表里（lib/provider-kinds.ts）：
// 那几家的地址常量住在 lib/*/config.ts，而那些文件要经 lib/config.ts 读库，
// 引进来就是这个环。面板答复里的默认地址由 lib/admin/service.ts 从注册表取。

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
 * `hidden` 是「目录里先备着、面板上还不给」的开关：`hidden: true` 的条目不播种、
 * 也不出现在「新增平台」的下拉里（它的会话或目录还没接完时，播出来就是一个地址、
 * 目录、额度全空的平台，面板上看得见却用不了）。放开一条只改这一个布尔，下一次
 * 启动就播；不想让它再被建就改回 true。现在每一条都是 `hidden: false`。
 */
export const SIMULATED_CLIENTS: readonly SimulatedClientPreset[] = [
  { key: "minimax", id: "minimax", label: "MiniMax Code", kind: "minimax", region: "cn", hidden: false },
  { key: "qoder-global", id: "qoder", label: "Qoder（全球区）", kind: "qoder", region: "global", hidden: false },
  { key: "qoder-cn", id: "qoder-cn", label: "Qoder（中国区）", kind: "qoder", region: "cn", hidden: false },
  { key: "workbuddy-cn", id: "workbuddy-cn", label: "WorkBuddy（中国区）", kind: "workbuddy", region: "cn", hidden: false },
  { key: "workbuddy-global", id: "workbuddy-global", label: "WorkBuddy（国际区）", kind: "workbuddy", region: "global", hidden: false },
  { key: "zcode", id: "zcode", label: "ZCode", kind: "zcode", region: "", hidden: false },
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

/** 这个 id 是不是预置的模拟客户端平台（目录里的每一条，hidden 的也算）。 */
export function isSimulatedClientId(id: string): boolean {
  return SIMULATED_CLIENTS.some((client) => client.id === id);
}

/**
 * 面板上看得见、也建得了的那几条模拟客户端（hidden 的除外）。
 *
 * hidden 是「目录里先备着、面板上还不给」：置了 true 的那条在建行时被跳过。读目录
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
 * 平台属于哪一族。
 *
 * dialect      用户自己加的平台（选的是报文格式）：模型目录归上游。
 * simulated    预置的模拟客户端：模型目录归代码。
 */
export type PlatformCategory = "dialect" | "simulated";

/**
 * 用户能自己建的一类平台：面板上「新增平台」的那个下拉，一格一条。
 *
 * 这一张说的是「用户能建哪几种」：方言与厂商五家都在里面，模拟客户端不在
 * （它们走预置目录那一套）。
 */
export interface PlatformKindOption {
  kind: string;
  label: string;
  /** 方言（用户自己加，选的是报文格式）还是预置的模拟客户端（从目录里挑一个）。 */
  category: PlatformCategory;
  /** 预置平台建出来的 id（方言类为空串：id 由用户填）。 */
  presetId: string;
  /** 区域（cn / global / 空串）。方言类为空串。 */
  region: string;
  defaultBaseUrl: string;
}

/**
 * 能建的平台种类，顺序就是面板上下拉的顺序。
 *
 * 两类方言（openai / anthropic）：向上游讲 OpenAI 格式，还是讲 Anthropic
 * Messages 格式。哪家中转站、哪个自建服务，只有用户知道，所以没有默认地址。
 *
 * 厂商五家（七牛云 / 讯飞星火 / SenseNova / 书生·端砚 / TokenRhythm）不在：
 * 它们不再是「能新建的一类平台」，存量行由启动时的迁移改成通用方言
 * （lib/store.ts 的 migrateLegacyVendorKinds），从此按 openai 那一类走。
 *
 * 模拟客户端那五家（minimax / qoder / qoder-cn / workbuddy-cn /
 * workbuddy-global）不在：一个客户端一份会话，靠登录拿凭据，
 * 建出来的空平台没有模拟端可用。它们走预置目录那一套（platformKindChoices）。
 *
 * 目录归上游还是归代码，由平台所属的族决定（platformCategoryOfKind）：方言族从
 * 上游拉，模拟客户端用代码里写死的那份。这一格不决定目录的来源。
 */
export const PLATFORM_KIND_OPTIONS: readonly PlatformKindOption[] = [
  {
    kind: "openai",
    label: "OpenAI 兼容",
    category: "dialect",
    presetId: "",
    region: "",
    defaultBaseUrl: "",
  },
  {
    kind: "anthropic",
    label: "Anthropic 兼容",
    category: "dialect",
    presetId: "",
    region: "",
    defaultBaseUrl: "",
  },
];

/** 能建的这一类平台。认不出就是 null（不能建的那种）。 */
export function platformKindOptionOf(kind: string): PlatformKindOption | null {
  return PLATFORM_KIND_OPTIONS.find((option) => option.kind === kind) ?? null;
}

/**
 * 这一类平台属于哪一族。
 *
 * 模型目录归谁由这一族决定：方言族一律从上游拉，模拟客户端一族用代码里的
 * 目录。判据只有这一处（模拟客户端那一族是预置目录里登记的那几条）——
 * 别的地方要问就读它，别自己再按 kind 写一遍名单。
 */
export function platformCategoryOfKind(kind: string): PlatformCategory {
  return isSimulatedClientKind(kind) ? "simulated" : "dialect";
}

/**
 * 面板上「新增平台」那一屏能选的全部：先方言，再模拟客户端。
 *
 * 两族分开报（category）：方言类要用户填 id 与地址，模拟客户端类的 id、地址、
 * 区域都由预置定死 —— 面板按这一格决定问不问那两格。hidden 的条目不出现，
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
  }));
  return [...PLATFORM_KIND_OPTIONS, ...simulated];
}
