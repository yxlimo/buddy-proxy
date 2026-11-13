// lib/provider-kinds.ts — the registry: what each kind of upstream knows how to do.
//
// The behaviour of a kind used to live in seven switch statements, one per
// question ("what is its address", "what models does it have", "how much is
// left", …). Adding a kind meant writing a case in each of them, and two
// accounts of the same kind could not be told apart at all.
//
// A kind is one entry here instead. The row says which kind it is and which
// one of that kind it is; the registry says how to talk to that kind.
//
// What is NOT here: the call to the upstream. That lives with the transport it
// belongs to (lib/router/upstreams/) — one dispatch, not one per question.

import type Koa from "koa";
import { CredentialState } from "./gen/buddy/admin/v1/admin_pb.ts";
import type { Json } from "./json.ts";
import type { ProviderPolicy, ProviderRow } from "./providers.ts";
import type { CatalogModel } from "./router/catalog.ts";
import type { Dialect } from "./router/deliver.ts";
import type { Route } from "./router/routes.ts";
// 只为快照里那一桶的类型：额度插件问回来的结论。
import type { QuotaProbe } from "./quota-plugins.ts";
// 只为 `dispatch` 的参数类型：upstreams/tokenrhythm.ts 从这边取 kindOf，值上不互相引用。
import type { UpstreamContext } from "./router/upstreams/index.ts";
// 人工元数据那一层：注册表是它唯一的调用方（见 registerKind）。这一条引用只
// 引 lib/store.ts 与叶子模块，不会再绕回这里 —— 否则注册表求值期的顺序就成了
// 隐患。
import { applyModelOverrides } from "./model-overrides.ts";
/** 面板上登录的方式。 */
export type ProviderLoginMethod = "device" | "browser" | "password" | "code" | "api_key";

/**
 * 这一类上游发推理请求时拿哪一份凭据。
 *
 * 有的平台配了两份凭据：会话（问额度用）与 key（推理用）。只有这一份是
 * 推理凭据。
 */
export type InferenceCredential = "session" | "api_key";

/* ------------------------------------------------------------------ *
 * The credential shape: what one account of a kind keeps, as a declaration
 * ------------------------------------------------------------------ */

/**
 * 凭据的形态。
 *
 * 「能不能拿去推理」不写在每一段上：注册表的 `inferWith` 说这一类用哪一段，
 * 形态说出这一段是哪一种，两者一致才是推理凭据（见 lib/admin/accounts.ts 的
 * canInfer）。写两处就会有两处走样的机会。
 */
export type CredentialForm = "session" | "api_key" | "cookie";

/**
 * 凭据形状要的那个账号。
 *
 * 只有三样：哪一行、属于哪个平台、什么种类。`ProviderRow` 满足它；写凭据那
 * 一条路也有没有行的时候（面板把平台 id 当账号 id 交回来），那时凑的是「平台
 * id 就是它第一个账号的 id」这个约定。
 */
export interface CredentialOwner {
  id: string;
  platform: string;
  kind: string;
}

/** 会话记录报的那几样：过期、代数、最近一次成功、平台拒过没有。 */
export interface SessionFacts {
  /** 到期时刻（毫秒）。0 = 这份会话没有到期时间。 */
  expiresAt: number;
  generation: number;
  /** 最近一次拿到它的时刻（毫秒）。 */
  lastOkAt: number;
  /** 平台拒过这份会话：它已经作废了。 */
  refused: boolean;
}

/** 一段读出来的凭据。 */
export interface SlotReading {
  /** 库里那条记录的 id：面板拿它「试一下」「刷新一下」。 */
  id: string;
  /** 这一段算不算配好了。会话看记录在不在，key 看值在不在 —— 两种都出现过。 */
  present: boolean;
  /** 值。只用来算掩码与指纹，不上屏。 */
  value: string;
  /** 库里那条记录最后一次写进来的时刻。 */
  updatedAt: number;
  /** 会话那一段才有。 */
  session?: SessionFacts;
}

/**
 * 账号名下的一个凭据位置：面板上就是一行。
 *
 * 一个位置只描述「面板上哪一行、值从哪儿读」：状态怎么算、能不能推理、给谁
 * 看，都在读出来的那一层统一判（lib/admin/accounts.ts）。各家自己判一遍，就
 * 会有几份不一样的判断。
 */
export interface CredentialSlot {
  /** 面板上这一行叫什么：登录会话 / 推理 Key / 额度 Cookie。 */
  label: string;
  form: CredentialForm;
  /** 读这一段：一个位置只读一次，免得同一行来来回回翻库。 */
  read(account: CredentialOwner): SlotReading;
  /** 没配也列一行：面板上要看得见「这段还没填」，而不是看不见。 */
  alwaysList?: boolean;
}

/** 面板上要填的一格。位置就是 `SetProviderKeys` 的 keys[] 顺序。 */
export interface CredentialField {
  /** 这一格的名字（面板的 htmlFor 用它，稳定就够）。 */
  name: string;
  label: string;
  /** 标签下面那一行提示：这一格拿来做什么、留空会怎样。 */
  hint?: string;
  /** 输入框里的占位提示。 */
  placeholder?: string;
}

/**
 * 这一类平台的凭据：面板上的行、要填的格、按位置怎么写。
 *
 * 以前这三样是分开写在三处的（`credentialsOf` 的 switch、`setProviderKeys` 的
 * switch、面板那张 LAYOUTS 表），于是一个平台有几种叫法、多出几行没人认得出
 * 来。现在一个种类一份声明，读、填、写都从这一份走。
 */
export interface CredentialPlan {
  /** 面板上这个账号的凭据行，按面板上的顺序。 */
  slots(account: CredentialOwner): CredentialSlot[];
  /**
   * 面板上要填的格子，按顺序。
   *
   * 空数组 = 这一类不收 key（凭据是登录会话，贴 key 过来只能拒）。
   */
  fields(account: CredentialOwner): CredentialField[];
  /** 按位置写：`values` 与 `fields` 一一对应。返回写进去几段。 */
  write(account: CredentialOwner, values: string[]): number;
  /**
   * 段数到运行时才知道（开放平台：由平台那一行指名的额度插件说了算）。
   *
   * 只有这种平台要判「发来的段数够不够」：面板的插件登记表没到手时，它只知道
   * 推理那一格，保存上去的数组就短了，按位置写下去会把插件那几段当成空串清掉
   * —— 那是静默丢凭据。段数定死的种类不判：空数组就是「都清掉」，那是现有的
   * 语义。
   */
  dynamicFields?: boolean;
  /** 面板上那个弹窗的标题。 */
  title: string;
  /**
   * 保存/清除之后那句话里的名字（「已保存七牛云的…」）。
   *
   * 不给就用种类的 label。开放平台是另一回事：它的名字在平台那一行上（一个
   * 平台一种业务，种类名只能说「开放平台」）。
   */
  name?(account: CredentialOwner): string;
  /**
   * 这一类不收 key 时说得出的那句事实（英文，不进面板文案）。
   *
   * 不给的走「这一类没有 key 可写」：说不清就不说，不替它编。
   */
  noKeyNote?: string;
}

/** 一次签到的结果。 */
export interface BenefitOutcome {
  /** 上游的 id。 */
  upstream: string;
  /** 成了没有。 */
  ok: boolean;
  /** 拿到的积分数。 */
  credits: number;
  /**
   * 今天这一签确实到账了。
   *
   * 平台说「重放」（今天已经领过）也算：积分是今天到的账，只是不是这一轮
   * 拿的。面板上「签到了但这次没加积分」就靠它 —— 只看 credits 会把已经
   * 签到说成没签。
   */
  signedIn?: boolean;
  /**
   * 这个平台根本没有每日签到。
   *
   * 跟「今天还没签」是两件事：后者是还欠着，前者是压根没有这回事。没有哪
   * 一类现在会写这个标记 —— 别拿「活动列表里没有每日签到」来推它：全球区的
   * 每日签到只是不在那个列表里（它在网页宿主上，API 拿不到），推出来就是
   * 冤枉那个平台。
   */
  noDailyCheckin?: boolean;
  /**
   * 这次没能确认今天签没签。
   *
   * 平台把签到状态放在我们够不着的地方：全球区的每日签到只在网页宿主上，
   * 它的 API 宿主根本不答这件事。这时候面板要说「没确认」，不能拿「今天没
   * 有新活动」顶上去 —— 那是在替平台说它没说的话。
   */
  statusUnavailable?: boolean;
  /** 给人看的几行话。 */
  report: string[];
  /** 什么时候跑的。 */
  at: string;
}

/* ------------------------------------------------------------------ *
 * The shapes the panel reads
 * ------------------------------------------------------------------ */

/** 一条凭据的样子。 */
export interface CredentialView {
  /** session / api_key / login / plan_key */
  kind: string;
  /** 契约里的 CredentialState。 */
  status: CredentialState;
  /** 只留前几位。 */
  fingerprint: string;
  /** 到期时间（毫秒）。 */
  expiresAt: number;
  /** 还剩多少秒。 */
  remainingSec: number;
  warning: boolean;
  detail: string;
  generation: number;
}

/** 积分批次。 */
export interface CreditLotView {
  id: string;
  sourceLabel: string;
  remaining: number;
  expiresAt: number;
  status: string;
}

/** 余额批次。 */
export interface BalanceLotView {
  id: string;
  sourceLabel: string;
  remainingCny: number;
  expiresAt: number;
  status: string;
}

/** 积分：点数。 */
export interface CreditView {
  total: number;
  used: number;
  remaining: number;
  lots: CreditLotView[];
  note: string;
}

/** 余额：钱。 */
export interface BalanceView {
  availableCny: number;
  currency: string;
  lots: BalanceLotView[];
  /** 最近到期的那批的到期时间。 */
  nextExpiryAt: number;
  /** 会过期的那部分。 */
  expiringCny: number;
}

/** 套餐额度的一个窗口。 */
export interface TokenPlanWindowView {
  /** general / video。 */
  label: string;
  intervalPercent: number;
  weeklyPercent: number;
  intervalEndsAt: number;
  weeklyEndsAt: number;
}

/** 套餐额度：按窗口的百分比。 */
export interface TokenPlanView {
  windows: TokenPlanWindowView[];
}

/** 一个额度。 */
export interface QuotaView {
  /** 这个额度属于哪个 provider。 */
  upstreamId: string;
  /** 属于哪个账号。 */
  accountId: string;
  /** 账号的名字（账号行上的 alias）。空串 = 没设名字。 */
  accountName?: string;
  balance?: BalanceView;
  credits?: CreditView;
  tokenPlan?: TokenPlanView;
}

/**
 * /health 里的快照：各家报上来的原始数字。
 *
 * 按上游分开：两个同类的上游各有各的数字。
 */
export interface HealthSnapshot {
  qoder: Record<string, { account: unknown; credits: unknown; quota?: unknown }>;
  minimax: Record<
    string,
    {
      balance: unknown;
      tokenPlan: unknown;
      credits: unknown;
      /** 积分，以及「plan 见底后自动扣积分」的开关：plan 窗口见底时看这两个。 */
      points?: { amount: number | null; at: number };
      creditFallbackEnabled?: { enabled: boolean | null; at: number };
    }
  >;
  /** ZCode 的 Start Plan 额度。 */
  zcode: Record<string, { quota: unknown }>;
  workbuddy: Record<string, { credits: unknown }>;
  /**
   * 额度插件问回来的结论：插件 id → 账号 id → 那一次的结论。
   *
   * 上面那几个桶是自带抓取逻辑的平台留下的（它们还没搬成插件）。额度归插件的
   * 那些平台没有具名桶 —— 包括开放平台（数据，插件由平台那一行指名）与三家插件
   * 随 kind 一起登记的平台（SenseNova、TokenRhythm、书生·端砚）。
   *
   * 存结论而不存原样答复：状态怎么处理是平台的事（lib/quota-state.ts），插件只
   * 管翻译，快照里存的就只能是翻译完的东西。
   */
  plugins: Record<string, Record<string, QuotaProbe>>;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/** 一个种类知道的事。 */
export interface ProviderKind {
  /** 种类名：provider 表里的 kind。 */
  kind: string;
  /** 面板上显示的名字（没有别名的时候用这个）。 */
  label: string;
  /** 登录办法。 */
  login: ProviderLoginMethod;
  /** 这个种类要区域吗（Qoder 有全球区与中国区之分）。 */
  needsRegion?: boolean;
  /**
   * 是开放 API 平台吗（TokenRhythm、SenseNova、书生·端砚）。
   *
   * 平台是直接转发的：agent 写的请求原样过去，会话相关的头也跟着过去。
   * 模拟客户端的那些（Qoder、WorkBuddy、MiniMax Code、ZCode）是按客户端的
   * 样子重建请求的 —— 多余的头直接无视。
   */
  openPlatform?: boolean;
  /**
   * 这一类平台默认的推理地址（空 = 没有）。
   *
   * 说的是「这一类平台默认指哪台」：额度请求靠它分辨「行上的地址还是默认那台」
   * （lib/quota-plugins.ts 的 quotaEndpointBase）。行上的地址还等于它时，额度
   * 问插件自己那台（门户、控制台、钱包）；用户把行指到别处时，跟着行走。
   *
   * 它是适配器自己的能力描述，跟 catalogAuth 一样 —— 不是
   * 平台清单：平台行是用户在面板上自己建的（表里的行），代码这边不列平台。
   *
   * 登记时一次成形：给就是给了，不给就没有，没有「登记完再回头补」的第二步。
   */
  defaultBaseUrl?: string;
  /**
   * 这一类平台默认用哪个额度插件。
   *
   * 空 = 这一类没有额度接口（面板上那一格是空的，不是「不知道」）。
   *
   * 它是这一类平台的能力描述，跟 defaultBaseUrl 同一形态：建平台时面板拿它
   * 预填那一格（用户可以改），平台行上填的是用户最后选的那个。
   */
  defaultQuotaPlugin?: string;
  /** 区域都有哪些。 */
  regions?: string[];
  /**
   * 这一类上游支持的生效策略。
   *
   * 策略是「名下的多个账号怎么选」：只有一个账号的上游选了也没有用，所以
   * 那些种类只给「单一」。
   */
  policies?: ProviderPolicy[];
  /** 基础地址。 */
  baseUrl(provider: ProviderRow): string;
  /**
   * 这一类上游发推理请求时拿哪一份凭据。
   *
   * 有的平台配了两份凭据：会话（只用来问额度）与 key（推理用）。只有这里
   * 指的那一份能拿去推理 —— 别的配了也不算数。所以「这个账号能不能推理」
   * 按它判，不按「有没有配凭据」判：配了门户 cookie 的七牛云账号，一个
   * 请求也发不出去。
   */
  inferWith: InferenceCredential;
  /**
   * 发推理请求时用的那把**明文** key。空串表示没有。
   *
   * 与 `inferenceCredentialOf`（lib/admin/accounts.ts）不是一回事：那个给的是
   * 面板要看的一条凭据（掩码、指纹、状态），拿不去发请求。这里只回答「发请求
   * 时带什么」，也就是转发层与「问上游要模型目录」要的那一份。
   *
   * 只有以 key 鉴权的种类才有这一项：`inferWith` 是 session 的种类，凭据就是
   * 会话本身，没有第二把 key 可给。
   *
   * 第二个参数是策略选中的那个账号：一个平台下有多个账号，key 是按账号取的，
   * 而 `provider` 只说明是哪个平台。
   */
  keyOf?(provider: ProviderRow, accountId?: string): string;
  /**
   * 问上游要模型目录（`/models`）时带的鉴权头。
   *
   * 目录那一个端点的鉴权跟着方言走：多数上游收 `Authorization: Bearer`，
   * Anthropic 那一族只认 `x-api-key` 加版本头 —— 发错了上游回 401，看着像
   * key 不对，其实是头不对，目录永远拉不到。
   *
   * 没有这一项的种类按 Bearer 发：那是绝大多数上游的约定，保底行为不变。
   */
  catalogAuth?(key: string): Record<string, string>;
  /** 凭据。 */
  credential(provider: ProviderRow): CredentialView;
  /**
   * 这个账号的凭据长什么样：有哪几段、面板上怎么填、按位置怎么写。
   *
   * 没有这一项的种类一条凭据也列不出来：凭据的形状是这一类上游自己的事，
   * 别处不再写第二份。
   */
  credentials: CredentialPlan;
  /** 模型目录。 */
  models(provider: ProviderRow): CatalogModel[];
  /** 额度。 */
  quotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[];
  /** 额度用尽了吗（读不到就说不知道）。 */
  outOfCredits(provider: ProviderRow, snapshot: HealthSnapshot): boolean;
  /**
   * 额度什么时候回来（Unix 毫秒）。null = 不知道。
   *
   * 只在账号确实见底时有意义：这是「等多久能再用」，不是「下次重置」。
   */
  recoverAt?(provider: ProviderRow, snapshot: HealthSnapshot): number | null;
  /**
   * 这一类上游的每日签到。
   *
   * 没有这一项的种类不签到：签到是账号的事，写在种类里，加一个种类就是
   * 登记一次，而不是在签到那里再写一个 if/else。
   */
  benefits?(provider: ProviderRow): Promise<BenefitOutcome>;
  /**
   * 定时刷新这个上游的会话。
   *
   * 官方客户端自己按时间表换令牌，不等人来点。网关也这样：种类说得出自己
   * 怎么刷，定时器（lib/periodic.ts）只管按时叫它。
   *
   * 没有这一项的种类不刷：它的凭据不是会话（key、账号密码），不轮换。
   *
   * 这是**唯一**换令牌的地方：请求那一条路不换（它看到过期就报错）。令牌
   * 是一次性的，两处同时换，平台会当成重放，把整个会话撤掉。
   */
  refresh?(provider: ProviderRow): Promise<void>;
  /**
   * 定时扫描这个上游的状态，把「现在该用哪个账户」定下来。
   *
   * 中转站的赠金会过期：最先到期的那个账户该先用，而那是余额说了算。
   * 定时器（lib/periodic.ts）按时调它。
   */
  scan?(provider: ProviderRow): Promise<void>;
  /**
   * 这个失败是不是「余额不足」。
   *
   * 余额到期优先是个包过的单一：钉住的账户接不了时，这个钩子说「是余额
   * 没了」，于是重新扫描、重新钉一个别的接手。
   */
  isRequestMissingBalance?(error: unknown): boolean;
  /**
   * 这一类上游怎么转发。没有它就说明这个种类还没接。
   *
   * 请求怎么发出去、答案怎么写回客户端，是转发那一条路的事
   * （lib/router/upstreams/）。写在种类里，接一个种类就是登记一次，
   * 而不是在 `router-proxy.ts` 的 switch 里再加一个 case。
   */
  dispatch?(
    ctx: UpstreamContext,
    body: Json,
    route: Route,
    dialect: Dialect,
    stream: boolean,
    out: Koa.Context,
  ): Promise<void>;
}

/** 把上游报的状态翻成面板要的那一套。 */
export function fromUpstreamStatus(raw: Record<string, unknown>, kind: string): CredentialView {
  const status = String(raw.status ?? "");
  const remainingSec = Number(raw.remainingSec ?? 0);
  const expiresAt = raw.expiresAt ? Date.parse(String(raw.expiresAt)) : 0;
  const warning = raw.warning === true;
  const detail = String(raw.detail ?? "");
  return {
    kind,
    status: credentialStateOf(status),
    fingerprint: String(raw.fingerprint ?? ""),
    expiresAt,
    remainingSec,
    warning,
    detail: warning && !detail ? "凭据即将到期" : detail,
    generation: Number(raw.generation ?? 0),
  };
}

/** 上游的状态词 → 契约里的枚举。 */
function credentialStateOf(status: string): CredentialState {
  switch (status) {
    case "authenticated":
      return CredentialState.AUTHENTICATED;
    case "expired":
      return CredentialState.EXPIRED;
    case "error":
      return CredentialState.ERROR;
    case "usable":
      return CredentialState.USABLE;
    case "anonymous":
      // The upstreams that report "anonymous" mean it as "not logged in"
      // (qoder, workbuddy, minimax all do): no credential, so it is missing.
      return CredentialState.MISSING;
    case "missing":
      return CredentialState.MISSING;
    default:
      return CredentialState.MISSING;
  }
}

const REGISTRY = new Map<string, ProviderKind>();

/**
 * 登记一个种类。
 *
 * 目录多加一层：人写的元数据是发布目录的最后一道覆盖（lib/model-overrides.ts）。
 * 包在这里而不是各家 models() 里，是因为登记只有一个入口，目录出口却有好几个
 * —— 五家从 lib/kinds/shared.ts 转登记，anthropic 与 registerCompatiblePlatform
 * 直接从这一层登记；按家接，迟早漏掉一个（qoder / minimax / zcode 那次就漏了）。
 */
export function registerKind(kind: ProviderKind): void {
  REGISTRY.set(kind.kind, {
    ...kind,
    models: (provider) => applyModelOverrides(provider.platform, kind.models(provider)),
  });
}

/** 一个种类。 */
export function kindOf(kind: string): ProviderKind | null {
  return REGISTRY.get(kind) ?? null;
}

/**
 * 这一类上游支持的策略。
 *
 * 没登记的种类只给「单一」：别的策略要有多个账号才有用，而多账号是各家
 * 自己的形态（开放平台一把 key 一个租户，中转站一个账号一个钱包）。
 *
 * 兜底只在这里一份：注册表里漏填 policies 的种类从这里过一遍，别处不再
 * 自己写一遍默认策略。
 */
export function policiesOfKind(kind: string): ProviderPolicy[] {
  return kindOf(kind)?.policies ?? ["single"];
}

/** 全部种类。 */
export function allKinds(): ProviderKind[] {
  return [...REGISTRY.values()];
}

/**
 * 这一类上游的凭据声明。
 *
 * 没登记的种类给一份空的：一条凭据也列不出来，一把 key 也写不进去。那是「不
 * 知道」，不是「没有凭据」—— 种类没登记，猜不得。
 */
export function credentialsOfKind(kind: string): CredentialPlan {
  return kindOf(kind)?.credentials ?? EMPTY_CREDENTIALS;
}

/** 没登记凭据形状的那些种类走这一份：什么都不列、什么都不写。 */
const EMPTY_CREDENTIALS: CredentialPlan = {
  title: "",
  slots: () => [],
  fields: () => [],
  write: () => 0,
};

/**
 * 面板上能选的类型。
 *
 * The panel asks; it does not keep a list of its own.
 */
export function selectableKinds(): {
  kind: string;
  label: string;
  login: ProviderLoginMethod;
  needsRegion: boolean;
  regions: string[];
  policies: ProviderPolicy[];
  credentialTitle: string;
  credentialFields: CredentialField[];
}[] {
  return allKinds().map((k) => ({
    kind: k.kind,
    label: k.label,
    login: k.login,
    needsRegion: k.needsRegion ?? false,
    regions: k.regions ?? [],
    policies: policiesOfKind(k.kind),
    credentialTitle: k.credentials.title,
    // 平台的额度插件那几段不在这一份里：它们挂在平台那一行上（插件由平台指
    // 名），面板自己把它接在后面。这里只有这个种类自己定死的那几格。
    credentialFields: k.credentials.fields({ id: k.kind, platform: k.kind, kind: k.kind }),
  }));
}
