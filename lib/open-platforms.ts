// lib/open-platforms.ts — 开放平台：平台表里的行，一行一个平台。
//
// 平台的唯一数据源就是这张表（代码里的模板名单已清空，见
// lib/platform-templates.ts）：模拟客户端那一族由启动时的播种补行，厂商那几家由
// 平台模板表补行，用户自己加的就是面板上建的那一行。
//
// 这一层只管数据：账号、路由与面板的接线是后面的阶段。
//
// 它不引 lib/platforms.ts —— 那一层要引它（平台列表从这张表出），反过来引就
// 成环。

import { forgetPlatformPresetRemoved, rememberPlatformPresetRemoved, store } from "./store.ts";
// 能建的平台种类：建的时候要照着它校验，拒绝时要把可选的列出来。
import {
  isSimulatedClientId,
  isSimulatedClientKind,
  PLATFORM_KIND_OPTIONS,
  platformKindOptionOf,
  simulatedClientPresetsOfKind,
} from "./platform-catalog.ts";
// 额度插件的登记表（lib/quota-plugins.ts）反过来要读这一层的平台表，所以这两
// 个模块是个环。环上的模块不能在求值期读别人的常量：这里只在函数里用它，
// 那里也不在求值期读这边的东西。
import { allQuotaPlugins, quotaPluginOf } from "./quota-plugins.ts";
// kind 注册表：这一类的能力描述（能不能拉模型目录、默认地址）事实在那边。
import { kindOf } from "./provider-kinds.ts";
// 失败的机器码与排查用的事实。文案在面板那一侧，这里只说「哪一格不对」。
import type { AdminFailure, AdminResult } from "./admin/error-codes.ts";

/**
 * 开放平台的 kind 名字。
 *
 * 表里那些平台（用户自己加的）都是这一类：转发、方言、鉴权对它们完全一样，
 * 差别只在地址、key 与目录（lib/kinds/openai.ts）。
 *
 * 它住在这一层而不是 lib/platforms.ts：那一层引这一层，反过来引就成环，而环
 * 上的模块不能在求值期读别人的常量（登记 kind 时正好要读它）。
 */
export const OPEN_PLATFORM_KIND_NAME = "openai";

/**
 * 模型目录：有哪些模型、还自动不自动、上次什么时候拉的、哪来的。
 *
 * `auto` 与 `source` 是两件事：
 *
 *   auto    以后允不允许自动拉覆盖这一份目录（能查的那一格：models_auto）。
 *   source  现在这份目录是哪来的：自动拉的，还是人写的。
 *
 * 人手写了一份目录，source 就是 manual；自动那一格默认关掉 —— 写死的东西
 * 别再让它被自动拉覆盖。
 */
export interface OpenPlatformModels {
  /** 模型名。 */
  items: string[];
  /**
   * 模型的参数，按模型 id 存。
   *
   * 与 items 一起写、一起读：items 是「这个平台有哪些模型」的唯一来源，参数只是
   * 那些模型各自的能力。老行（JSON 里没有这一格）读成空对象 —— 空的意思是我们
   * 不知道，不是「什么都不能」。
   */
  traits: Record<string, ModelTraits>;
  /** 以后允不允许自动拉覆盖这一份目录。 */
  auto: boolean;
  /** 上次拉目录的时刻（毫秒）。0 = 没拉过（手写的目录）。 */
  fetchedAt: number;
  /** 现在这份目录是哪来的：自动拉的，还是人写的。 */
  source: "auto" | "manual";
}

/**
 * 一个模型的参数：上游报的（或者人写在行里的），不是我们猜的。
 *
 * 每一格都可能没有。没有与「0」「false」是两件事：false 会被客户端读成「不支持
 * 这个模型调工具」，0 会被读成「免费」。所以这里全是可选字段，写进来的值一定来自
 * 上游的明确答复，取不到就不写这一格（见 lib/open-platform-catalog.ts 那张路径表）。
 */
export interface ModelTraits {
  /** 上下文窗口（token）。 */
  contextWindow?: number;
  /** 输出上限（token）。上游没报就没有，客户端问多少就发多少。 */
  maxOutputTokens?: number;
  /** 能不能思考。 */
  reasoning?: boolean;
  /** 能选的思考档位。空数组是上游明确说「没有档位」，不是不知道。 */
  efforts?: string[];
  /** 默认档位。列表那一层还没有这一格（CatalogModel），先存在行里。 */
  defaultEffort?: string;
  /** 能不能调工具。 */
  toolCall?: boolean;
  /** 按什么倍率计费：0 是免费。单位不明的那一份不取（见路径表）。 */
  credits?: number;
}

/** 表里的一行。 */
export interface OpenPlatformRow {
  /** 路径里那一段。 */
  id: string;
  /** 面板上给人看的名字。 */
  label: string;
  /** 基础地址。 */
  baseUrl: string;
  /** 模型目录。 */
  models: OpenPlatformModels;
  /** 额度那一份的插件名（空串就是没有）。 */
  quotaPlugin: string;
  /** 怎么跟它说话（kind 注册表里的那一类）。 */
  kind: string;
  /** 区域（空串就是没有）。 */
  region: string;
  /**
   * 平台自己给的信息不足时，从共性表（lib/common-model-traits.ts）里补参数。
   *
   * 默认关：共性表是人工整理的近似，只有用户明确打开才用。它只补字段、不造
   * 模型 —— 命中与不命中都不影响 items 里有哪些模型。
   */
  traitsFromCommon: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * 平台 id 的形状：小写字母、数字与连字符。
 *
 * 长度上限 31 个字符（第一个字符加上最多 30 个）：路径里那一段越短越好读，
 * 也给路由前缀留出余地。
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

/**
 * 网关自己占着的 id。
 *
 * 平台的 id 是请求路径里那一段（`/<platform>/v1/messages`），占着网关自己的
 * 那几段就绕不过来了。对应这几条路由：
 *
 *   v1       /v1/messages、/v1/chat/completions、/v1/models（根路由）
 *   admin    面板这一片的路径（旧的 JSON 路由在 /admin/…，现在是 Connect 的
 *            /buddy.admin.v1.AdminService/…，但这一段留给面板）
 *   health   /health（公开的健康检查）
 *   healthz  惯例上的健康检查名（现在没有这个端点，先占着）
 *   metrics  惯例上的指标端点名（现在没有这个端点，先占着）
 */
const RESERVED_IDS = new Set(["v1", "admin", "health", "healthz", "metrics"]);

/** 表里的全部开放平台，按 id 排。 */
export function listOpenPlatforms(): OpenPlatformRow[] {
  const rows = store()
    .prepare(
      "SELECT id, label, base_url, models, models_auto, traits_from_common, quota_plugin, kind, region, created_at, updated_at " +
        "FROM platform ORDER BY id",
    )
    .all() as any[];
  return rows.map(toRow);
}

/** 某一个开放平台。没有就是 null。 */
export function openPlatformOf(id: string): OpenPlatformRow | null {
  const row = store()
    .prepare(
      "SELECT id, label, base_url, models, models_auto, traits_from_common, quota_plugin, kind, region, created_at, updated_at " +
        "FROM platform WHERE id = ?",
    )
    .get(id) as any;
  return row ? toRow(row) : null;
}

/**
 * 加一个开放平台。
 *
 * id 必须是能放进路径里的那一段，而且不能跟网关自己的路径或者已有的账号撞 ——
 * 账号的 id 跟平台 id 共用一个命名空间，撞了面板分不清哪个是哪个。已经在表里的
 * id（包括播种进来的模拟客户端）当然也不能重。
 */
export function createOpenPlatform(input: {
  id: string;
  label: string;
  baseUrl: string;
  /**
   * 额度插件。不给 = 这一类声明了哪个就用哪个（kind 注册表里的 defaultQuotaPlugin）。
   *
   * 空串是「不用插件」：那是用户的明确意思，不走默认值。
   */
  quotaPlugin?: string;
  /** 哪一类适配器。空串 = openai（OpenAI 兼容的通用平台）。 */
  kind?: string;
  /**
   * 模型目录。给了就用这份；不给就看这一类声明的那一份（kind 注册表里的
   * defaultModels），也没声明就建一个空目录。
   */
  models?: string[];
}): AdminResult {
  const id = String(input.id ?? "").trim();
  const problem = checkId(id);
  if (problem) return problem;
  if (openPlatformOf(id)) {
    return { ok: false, code: "PLATFORM_ALREADY_EXISTS", message: `platform ${id} already exists` };
  }
  const label = String(input.label ?? "").trim();
  if (!label) return { ok: false, code: "PLATFORM_LABEL_MISSING", message: "label is empty" };
  // 空串 = 通用那一类：契约里 AddPlatformRequest.kind 就是这么约定的（老面板
  // 不带这一格，建出来还是原来那个东西）。
  const kind = String(input.kind ?? "").trim() || OPEN_PLATFORM_KIND_NAME;

  let baseUrl = String(input.baseUrl ?? "").trim();
  // 没给 = 这一类默认用哪个插件；给了空串 = 不用插件（用户的明确意思）。
  let quotaPlugin =
    input.quotaPlugin === undefined
      ? (kindOf(kind)?.defaultQuotaPlugin ?? "")
      : String(input.quotaPlugin).trim();
  let region = "";
  let modelsAuto = true;

  if (isSimulatedClientKind(kind)) {
    // 预置的模拟客户端：它不是「往某个地址讲某种方言」，而是冒充一个封闭
    // 客户端 —— 地址、区域、id 都是那个客户端的身份（改了会话就接不上），
    // 所以按目录定死，请求里那几格不收。
    const presets = simulatedClientPresetsOfKind(kind);
    if (!presets.length) {
      // 走到这里只有一种原因：目录里有这一类、但每条都 hidden（zcode 那种，行由
      // 启动时的播种补，面板上还不给建）。说成「没有预置，得从预置里选一个」是
      // 自相矛盾，用户会以为列表没刷新。目录里根本没有这一类的进不来
      // （isSimulatedClientKind 就是「含 hidden 的条目在不在」），它们在下面
      // checkKind 里被拒，答复里列得出能建的那几种。
      return {
        ok: false,
        code: "PLATFORM_KIND_NOT_CREATABLE",
        message: `kind ${kind} is created by the internal preset only`,
      };
    }
    const preset = presets.find((candidate) => candidate.id === id);
    if (!preset) {
      // id 是请求路径里那一段，也是调用方 base_url 的那一段：让它随便填，
      // 建出来就是一个谁都不认识的平台。
      return {
        ok: false,
        code: "PLATFORM_ID_NOT_PRESET",
        message: `kind ${kind} wants one of ${presets.map((candidate) => candidate.id).join(", ")}, got ${id}`,
      };
    }
    baseUrl = "";
    // 额度插件将来要的话另说：模拟客户端的额度走自己的配额路径，不落在
    // platform 这一行上。
    quotaPlugin = "";
    region = preset.region;
    // 目录是代码挑过的一份，不让上游盖上来（上游那份更宽，会出现被上游拒的
    // 模型）。
    modelsAuto = false;
  } else {
    const urlProblem = checkBaseUrl(baseUrl);
    if (urlProblem) return urlProblem;
    const kindProblem = checkKind(kind);
    if (kindProblem) return kindProblem;
    const pluginProblem = checkQuotaPlugin(quotaPlugin);
    if (pluginProblem) return pluginProblem;
    // 目录能不能自动从上游拉，由 kind 注册表说了算（ProviderKind.modelsFromUpstream）：
    // 七牛与 TokenRhythm 的上游目录不归它管。认不出 kind 时兜底成「能拉」——
    // 这是兜底，不是结论。
    const kindMeta = kindOf(kind);
    modelsAuto = kindMeta ? kindMeta.modelsFromUpstream : true;
  }

  const now = Date.now();
  // 目录：用户给了就用用户那份；没给就写这一类代码里挑过的那一份（有的家才有）。
  // 写进去的那份算「自动来的」（source=auto）：它以后还能被上游那份盖上，
  // 人手写的那一份才是 manual。
  const kindMeta = kindOf(kind);
  const askedModels = input.models === undefined ? undefined : normalizeModels(input.models);
  const items = askedModels ?? [...(kindMeta?.defaultModels ?? [])];
  const models: OpenPlatformModels = { items, traits: {}, auto: modelsAuto, fetchedAt: 0, source: "auto" };
  const db = store();
  // 行与墓碑的清除在同一个事务里：只清墓碑而没写进行，播种就会把这个 id 当成
  // 「用户没删过但也不存在」—— 下次启动补回一个空平台，用户刚建的配置没了。
  db.exec("BEGIN IMMEDIATE");
  try {
    // kind 显式写：列的默认值是 openai，靠默认值就变成「谁都没说，反正建出来是
    // openai」—— 这一格现在由调用方定，写进去的必须是校验过的那一个。
    db.prepare(
      "INSERT INTO platform " +
        "(id, label, base_url, models, models_auto, quota_plugin, kind, region, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      label,
      normalizeBaseUrl(baseUrl),
      modelsJson(models),
      models.auto ? 1 : 0,
      quotaPlugin,
      kind,
      region,
      now,
      now,
    );
    // 这一行回来了，墓碑就作废：用户明确要的 id（可能是预置目录里被删过的那条），
    // 留着墓碑只会让下次启动的播种继续跳开它 —— 将来用户手写这个 id 的目录会被
    // 一次「表里已经有它」的 INSERT OR IGNORE 盖不住，而墓碑没用。
    forgetPlatformPresetRemoved(id);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已经没了 */
    }
    // 回滚之后墓碑还在：这个 id 仍然是「用户删过」，播种不该把它插回来。
    const detail = (e as Error)?.message ?? String(e);
    // 事务外那句 openPlatformOf 只在本进程看得到：两个进程同时建同一个 id 时，
    // 后一个撞在 INSERT 的唯一约束上 —— 那仍然是重名，有自己的码。其余照着
    // 原样拼进细节（字库层的原话，排查时要看）。
    if (/UNIQUE/i.test(detail) && /platform/i.test(detail)) {
      return { ok: false, code: "PLATFORM_ALREADY_EXISTS", message: `platform ${id} already exists: ${detail}` };
    }
    return { ok: false, code: "PLATFORM_WRITE_FAILED", message: `insert platform ${id} failed: ${detail}` };
  }
  return { ok: true, message: `已新增：${label}` };
}

/**
 * 改一个开放平台。
 *
 * 没给的字段不动：面板上只改名字的时候不能把地址顺手抹掉。
 */
export function updateOpenPlatform(
  id: string,
  patch: {
    label?: string;
    baseUrl?: string;
    quotaPlugin?: string;
    models?: string[];
    /**
     * 各模型的参数，跟 models 一起写。
     *
     * 不给就按 id 留着行里原来那些（清单里不再有的丢掉）：面板只改清单时不该把
     * 上游报回来的参数一起抹掉，而对同一个 id 来说那些参数仍然是同一份事实。
     */
    traits?: Record<string, ModelTraits>;
    modelsAuto?: boolean;
    /**
     * 这份目录是哪来的：自动拉的（auto）还是人写的（manual）。
     *
     * 不给就是「manual」：写了目录而没说哪来的，那多半是人写的。
     */
    source?: "auto" | "manual";
    /** 上次拉目录的时刻（毫秒）。0 = 没拉过。 */
    fetchedAt?: number;
    /**
     * 平台自己给的信息不足时从共性表里补参数。不给 = 别动这一格。
     *
     * 它不管哪一族平台：模板行与模拟客户端的行也有这一格（它们的目录同样是
     * 上游不报参数的那一种）。
     */
    traitsFromCommon?: boolean;
    /**
     * 想改类型。只收「跟现在一样」与空串，别的都拒。
     *
     * 线路上没有这一格（UpdatePlatformRequest 不含它，只有 AddPlatformRequest
     * 有）。写在这里是防内部调用方 —— 比如将来的迁移或脚本 —— 误以为能改。
     * 想换类型只能删了重建。
     */
    kind?: string;
  },
): AdminResult {
  const row = openPlatformOf(id);
  if (!row) return { ok: false, code: "PLATFORM_NOT_FOUND", message: `no platform ${id}` };
  // 类型建完就定下：换类型不是改一个字段，它名下的凭据、地址、目录都得跟着
  // 重算（七牛云要两段凭据、书生·端砚要两段，通用平台只要一段）—— 那是另一件
  // 事，不在「改平台」里做。同一类与空串当没传。
  const askedKind = String(patch.kind ?? "").trim();
  if (askedKind && askedKind !== row.kind) {
    return {
      ok: false,
      code: "PLATFORM_KIND_FIXED",
      message: `platform ${id} is ${row.kind}, change to ${askedKind} needs a rebuild`,
    };
  }
  const label = patch.label === undefined ? row.label : String(patch.label).trim();
  if (!label) return { ok: false, code: "PLATFORM_LABEL_MISSING", message: "label is empty" };
  // 模拟客户端的地址由预置定死（它是那个客户端的身份，改了会话就接不上）：
  // 面板上改个名字会送来空 base_url，那不是「把地址清空」而是要改别的格 —— 拿
  // 它去过非空校验，连改名都改不动。所以这一类不管请求里那一格，照库里存着。
  const simulated = isSimulatedClientKind(row.kind);
  const baseUrl = simulated
    ? row.baseUrl
    : patch.baseUrl === undefined
      ? row.baseUrl
      : String(patch.baseUrl).trim();
  if (!simulated) {
    const urlProblem = checkBaseUrl(baseUrl);
    if (urlProblem) return urlProblem;
  }
  // null 与没给是两回事：null 是「把这一格清空」，没给是「别动它」。
  const quotaPlugin = patch.quotaPlugin === undefined ? row.quotaPlugin : String(patch.quotaPlugin ?? "").trim();
  const pluginProblem = checkQuotaPlugin(quotaPlugin);
  if (pluginProblem) return pluginProblem;

  let models = row.models;
  // 目录同理也是那一类的一部分：模拟客户端能过哪些模型由代码挑（能过那个客户端
  // 的那一份），所以这两格也不管请求里怎么给，照库里存着。写入口只此一处，拦在
  // 这里才拦得住所有调用方（面板、脚本、迁移）；放在面板那层只能拦住面板。
  if (!simulated) {
    if (patch.models !== undefined) {
      const items = normalizeModels(patch.models);
      models = {
        items,
        traits:
          patch.traits === undefined
            ? normalizeTraitsMap(models.traits, items)
            : normalizeTraitsMap(patch.traits, items),
        // 人写的目录就不是自动拉的：写死了就别再让它被覆盖（显式说了要自动的
        // 除外 —— 那是明确的意思，不是默认值）。
        auto: patch.modelsAuto === undefined ? false : patch.modelsAuto === true,
        // 手写的目录没拉过：0 就是「没拉过」的意思。自动拉的那份记着拉的时刻，
        // 免得刚拉过又去问上游。
        fetchedAt: Number(patch.fetchedAt ?? 0) || 0,
        source: patch.source === "auto" ? "auto" : "manual",
      };
    } else if (patch.modelsAuto !== undefined) {
      // 只翻自动不自动，source 不动：source 说的是这份目录**现在**哪来的，
      // auto 说的是**以后**能不能被自动拉覆盖 —— 人把自动打开，不等于这份
      // 目录变成自动拉来的。这是有意的。
      models = { ...models, auto: patch.modelsAuto === true };
    }
  }

  store()
    .prepare(
      "UPDATE platform SET label = ?, base_url = ?, models = ?, models_auto = ?, quota_plugin = ?, " +
        "traits_from_common = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      label,
      normalizeBaseUrl(baseUrl),
      modelsJson(models),
      models.auto ? 1 : 0,
      quotaPlugin,
      patch.traitsFromCommon === undefined ? (row.traitsFromCommon ? 1 : 0) : patch.traitsFromCommon ? 1 : 0,
      Date.now(),
      id,
    );
  return { ok: true, message: "已保存" };
}

/**
 * 把上游刚拉到的目录写进平台那一行。
 *
 * 目录由行说了算（各 kind 的 models() 读它，见 lib/catalog-models.ts），而
 * SenseNova 与书生·端砚的目录只落在 cache 表 —— 两处不一起走，「上游答了、
 * 面板上还是空」就成了常态。
 *
 * 两道闸，缺一道就会把不该动的目录盖掉：
 *
 *   1. 人写死的那一份不同步（source=manual）：那是明确的意思，含「我把目录清空
 *      了」。
 *   2. 行上那一格「自动拉」关着就不同步：目录归谁管是**行自己的数据**
 *      （models_auto）。播种给代码挑的那一份写的是 0，所以七牛云、TokenRhythm
 *      这几家（上游那份更宽，七牛报 78 个模型）默认就盖不上来；人打开开关就是
 *      明确要上游那份。
 *
 * 行不存在也不同步：没有行可写。
 *
 * 参数按 id 保留：这次没报参数的那几个模型，行里原来那份留着（见
 * mergeModelTraits）。
 *
 * `fetchedAt` 跟着写成现在：它是「上次拉取的时刻」，面板拿它显示「上次拉取」；
 * 不写就等于说「从来没拉过」，而目录明明是刚拉回来的。`updated_at` 只在目录内容
 * 变了的时候动 —— 面板上那个「最后修改」说的是目录改过，不是每次问上游都算改。
 */
export function syncPlatformModels(
  platform: string,
  items: readonly unknown[],
  traits?: Record<string, ModelTraits>,
): void {
  const row = openPlatformOf(platform);
  if (!row) return;
  if (row.models.source === "manual") return;
  if (!row.models.auto) return;
  const next = normalizeModels(items);
  // 空的不写：把行清空会让人以为模型没了，而上游答一个空清单多半是没答好（与
  // lib/router/catalog-cache.ts 拒收空清单同一件事）。
  if (!next.length) return;
  // 参数跟着清单走：这次报了的用这次的，没报的按 id 留着行里原来那些。
  const keptTraits = mergeModelTraits(row.models.traits, next, traits ?? row.models.traits);
  const same =
    next.length === row.models.items.length &&
    next.every((id, i) => id === row.models.items[i]) &&
    sameTraits(keptTraits, row.models.traits);
  const now = Date.now();
  store()
    .prepare("UPDATE platform SET models = ?, updated_at = ? WHERE id = ?")
    .run(
      modelsJson({ ...row.models, items: next, traits: keptTraits, fetchedAt: now }),
      same ? row.updatedAt : now,
      platform,
    );
}

/** 两份参数表说的是不是同一件事（键序不算）。 */
function sameTraits(a: Record<string, ModelTraits>, b: Record<string, ModelTraits>): boolean {
  const canon = (traits: Record<string, ModelTraits>): string =>
    JSON.stringify(
      Object.keys(traits)
        .sort()
        .map((id) => [id, Object.entries(traits[id]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))]),
    );
  return canon(a) === canon(b);
}

/**
 * 删一个开放平台。
 *
 * 只删平台那一行：名下的账号与它们的凭据不归这一层管，级联由调用方负责
 * （那是账号层的事 —— 它才知道哪些凭据属于哪个账号）。调用方删平台之前
 * 必须自己把名下的账号删干净，否则那些账号就没有平台可挂了。
 *
 * 预置目录里的那几条删的时候多写一行墓碑（store 的 platform_preset_removed）：
 * 它们的行是启动时播的，不留记号的话删了等于重启长回来 —— 「删了就是没了」得靠
 * 这一行兑现。用户自己建的行不需要墓碑：没人会去播它。
 *
 * 存在性检查在事务里读：事务外先读一遍的话，读到行与进事务之间别的进程（NAS 上的
 * 管理脚本、另一个实例）可以把这个 id 删掉再重建 —— 本进程删掉的就是别人刚建好的
 * 那一行，还顺手记下「用户删过」，而用户看到的平台其实没被删。BEGIN IMMEDIATE 之后
 * 的读与删在同一个连接、同一个写事务里，中间插不进别人。
 *
 * 墓碑在删行成功之后写（同一个事务，原子性不受影响），没删到行就不写：一条都没删
 * 到却记「用户删过」，播种会永远跳开这个 id —— 记的是没发生过的事。
 */
export function deleteOpenPlatform(id: string): AdminResult {
  const db = store();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!openPlatformOf(id)) {
      db.exec("ROLLBACK");
      return { ok: false, code: "PLATFORM_NOT_FOUND", message: `no platform ${id}` };
    }
    const removed = db.prepare("DELETE FROM platform WHERE id = ?").run(id);
    if (Number(removed.changes) === 0) {
      db.exec("ROLLBACK");
      return { ok: false, code: "PLATFORM_NOT_FOUND", message: `no platform ${id} (nothing deleted)` };
    }
    if (isSimulatedClientId(id)) rememberPlatformPresetRemoved(id);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已经没了 */
    }
    throw new Error(
      `删除平台 ${id} 失败：${(e as Error)?.message ?? String(e)}。` +
        `事务已全部回滚，平台行与墓碑仍保持删除前的状态。`,
    );
  }
  return { ok: true, message: "已删除" };
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/** 这个 id 能不能用。不能的话给一个码。 */
function checkId(id: string): AdminFailure | null {
  if (!id) return { ok: false, code: "PLATFORM_ID_MISSING", message: "platform id is empty" };
  if (!ID_PATTERN.test(id)) {
    return { ok: false, code: "PLATFORM_ID_INVALID", message: `platform id ${id} is not [a-z0-9][a-z0-9-]{0,30}` };
  }
  if (RESERVED_IDS.has(id)) {
    return { ok: false, code: "PLATFORM_ID_RESERVED", message: `platform id ${id} is reserved by the gateway` };
  }
  if (isAccountId(id)) {
    return { ok: false, code: "PLATFORM_ID_TAKEN_BY_ACCOUNT", message: `platform id ${id} is an account id` };
  }
  return null;
}

/**
 * 这个 id 已经是一个账号了？
 *
 * 账号 id 与平台 id 共用一个命名空间：账号 id 是 `<平台>-<序号>`（`qoder-2`），
 * 跟平台 id 长得一样。面板按 id 查两边，撞了就分不清哪个是哪个 —— 所以
 * 账号先占了的名字，平台不能要。
 *
 * 查的是 provider 表，跟 lib/providers.ts 的 provider(id) 是同一张表。这里
 * 不引那一层：它引平台层，平台层引这里，再引回去就是一个环。
 */
function isAccountId(id: string): boolean {
  const row = store().prepare("SELECT id FROM provider WHERE id = ?").get(id);
  return row !== undefined;
}

/**
 * 额度插件这一格填的 id 得有人登记。
 *
 * 空串是「不用额度插件」，那是合法的一种选择。没登记的 id 一旦存下去，这个
 * 平台之后一条额度结论都不会有，而面板上看着「已选插件」—— 静默的不工作比
 * 拒绝保存更难查，所以拦在写库之前，一个字都不落库。
 *
 * 拒绝时要把登记过的插件列出来（用插件自己的 id：面板认得的就是这个 id）：
 * 只说「不行」，调用方没法自己改对。
 */
function checkQuotaPlugin(pluginId: string): AdminFailure | null {
  if (!pluginId) return null;
  if (quotaPluginOf(pluginId)) return null;
  const known = allQuotaPlugins().map((plugin) => plugin.id);
  return {
    ok: false,
    code: "QUOTA_PLUGIN_UNKNOWN",
    message: `no quota plugin ${pluginId}, registered: ${known.join(", ") || "(none)"}`,
  };
}

/**
 * 这一类平台建不建得了。
 *
 * 收下去的 kind 一旦是注册表里没有的那一个，这个平台就彻底接不了请求（路由
 * 按 kind 分派，认不出就无路可走），而面板上看得见它 —— 所以拦在写库之前。
 * 能建的那几个列进细节，排查时一眼看得见能选什么。
 */
function checkKind(kind: string): AdminFailure | null {
  if (platformKindOptionOf(kind)) return null;
  const known = PLATFORM_KIND_OPTIONS.map((option) => option.kind);
  return {
    ok: false,
    code: "PLATFORM_KIND_UNKNOWN",
    message: `no platform kind ${kind}, creatable: ${known.join(", ")}`,
  };
}

/** 地址能不能用。 */
function checkBaseUrl(value: string): AdminFailure | null {
  if (!value) return { ok: false, code: "PLATFORM_BASE_URL_MISSING", message: "base url is empty" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, code: "PLATFORM_BASE_URL_INVALID", message: `base url ${value} is not a url` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "PLATFORM_BASE_URL_INVALID", message: `base url ${value} is not http(s)` };
  }
  if (!url.hostname) {
    return { ok: false, code: "PLATFORM_BASE_URL_INVALID", message: `base url ${value} has no host` };
  }
  return null;
}

/**
 * 地址存进去之前去掉结尾的斜杠。
 *
 * 将来拼路径时不会拼出 `//v1` 那种东西（`https://x/v1` + `/v1/models`）。
 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ *
 * 模型目录
 * ------------------------------------------------------------------ */

/**
 * 目录存进库里的样子。
 *
 * 整个目录是一个 JSON：模型名、各模型参数、上次什么时候拉的、哪来的。
 *
 * 自动不自动**不在**这个 JSON 里：那一格在 models_auto 列上（能查的那一格），
 * JSON 里再存一份，两份迟早会走样。早期存过的 JSON 里带着 auto，读的时候
 * 当它不存在。
 *
 * 参数跟着清单一起写：`traits: { "<modelId>": { contextWindow: 256000 } }`。
 * 只写取到过的那几格，取不到的字段不出现 —— 写成 0 或 false 是另一份意思。
 */
function modelsJson(models: OpenPlatformModels): string {
  return JSON.stringify({
    items: models.items,
    traits: models.traits,
    fetchedAt: models.fetchedAt,
    source: models.source,
  });
}

/**
 * 读目录。
 *
 * 坏掉的 JSON 读成空目录，不抛：一个写坏的行不该让整个平台列表读不出来。
 * 自动不自动看那一列（能查的那一格），JSON 里那一份只是照抄 —— 早期存过
 * 的 JSON 里带着 auto，忽略它就是。
 */
function parseModels(raw: unknown, auto: boolean): OpenPlatformModels {
  const empty: OpenPlatformModels = { items: [], traits: {}, auto, fetchedAt: 0, source: "auto" };
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw ?? ""));
  } catch {
    return empty;
  }
  if (Array.isArray(parsed)) {
    // 早期存的是单纯的模型名数组。
    return { items: normalizeModels(parsed), traits: {}, auto, fetchedAt: 0, source: "auto" };
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const items = normalizeModels(Array.isArray(parsed.items) ? parsed.items : []);
  return {
    items,
    // 老行没有这一格：空对象 —— 我们不知道这些模型的参数，不是「什么都没」。
    traits: normalizeTraitsMap(parsed.traits, items),
    auto,
    fetchedAt: Number(parsed.fetchedAt ?? 0) || 0,
    source: parsed.source === "manual" ? "manual" : "auto",
  };
}

/** 模型名：去掉空的，去掉重号的。 */
function normalizeModels(items: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const name = String(raw ?? "").trim();
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * 参数里认的数。
 *
 * 0 照收：那是上游明确说的（上下文 0 罕见，倍率 0 就是免费）。负数、非数、
 * null 都算没有 —— 不拿一个猜的数去顶一个没报的数。
 */
export function traitNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

/** 一个模型的参数：只留认得的键，类型不对的当没写。 */
function normalizeTraits(raw: unknown): ModelTraits {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: ModelTraits = {};
  const contextWindow = traitNumber(src.contextWindow);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  const maxOutputTokens = traitNumber(src.maxOutputTokens);
  if (maxOutputTokens !== undefined) out.maxOutputTokens = maxOutputTokens;
  const credits = traitNumber(src.credits);
  if (credits !== undefined) out.credits = credits;
  if (typeof src.reasoning === "boolean") out.reasoning = src.reasoning;
  if (typeof src.toolCall === "boolean") out.toolCall = src.toolCall;
  if (typeof src.defaultEffort === "string" && src.defaultEffort.trim()) {
    out.defaultEffort = src.defaultEffort.trim();
  }
  if (Array.isArray(src.efforts)) {
    // 空数组照收：上游明确说「没有档位」，与「不知道有没有」不是同一件事。
    const efforts: string[] = [];
    for (const level of src.efforts) {
      const name = String(level ?? "").trim();
      if (!name || efforts.includes(name)) continue;
      efforts.push(name);
    }
    out.efforts = efforts;
  }
  return out;
}

/**
 * 一行的参数表：只留清单里还在的模型。
 *
 * 不在清单里的那几条是死数据（那是清目录之前的模型），留着只会让人以为它们
 * 还在服务。
 */
function normalizeTraitsMap(raw: unknown, ids: readonly string[]): Record<string, ModelTraits> {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, ModelTraits> = {};
  for (const id of ids) {
    const traits = normalizeTraits(src[id]);
    if (Object.keys(traits).length) out[id] = traits;
  }
  return out;
}

/**
 * 新目录的参数：这次说了的用这次的，没说的按 id 留着行里原来那份。
 *
 * 上游这次没报某个模型的参数，意思是「它没说话」，不是「参数变成了空」—— 把旧值
 * 一起擦掉等于一次抓取就把已知的事实丢掉。刷新目录（lib/open-platform-catalog.ts）
 * 与 cache 同步（syncPlatformModels）对这件事同一个口径。
 *
 * `reported` 只放上游真报了的：键不在、或者是个空对象，都当没说话。
 */
export function mergeModelTraits(
  previous: Record<string, ModelTraits>,
  ids: readonly string[],
  reported: Record<string, ModelTraits>,
): Record<string, ModelTraits> {
  const out: Record<string, ModelTraits> = {};
  for (const id of ids) {
    const said = reported[id];
    const traits = said && Object.keys(said).length ? said : previous[id];
    // 空对象就是一个参数也不知道：留一条空的只会让参数表看起来有内容。
    if (!traits || !Object.keys(traits).length) continue;
    out[id] = traits;
  }
  return out;
}

/** 一行变一个对象。 */
function toRow(row: any): OpenPlatformRow {
  const auto = Number(row.models_auto ?? 1) !== 0;
  return {
    id: String(row.id),
    label: String(row.label ?? ""),
    baseUrl: String(row.base_url ?? ""),
    models: parseModels(row.models, auto),
    quotaPlugin: String(row.quota_plugin ?? ""),
    kind: String(row.kind ?? "openai"),
    region: String(row.region ?? ""),
    traitsFromCommon: Number(row.traits_from_common ?? 0) !== 0,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}
