// lib/open-platforms.ts — 开放平台：用户自己加的平台，一行一个。
//
// 平台有两处数据源：代码里的模板（lib/platform-templates.ts）与这张表。模板
// 优先 —— 模板里有的 id，表里的那一行当没有。这样把模板加回代码时不用先清库，
// 回滚是安全的。
//
// 这一层只管数据：账号、路由与面板的接线是后面的阶段。
//
// 它不引 lib/platforms.ts —— 那一层要引它（平台列表要把两处数据源合起来），
// 反过来引就成环。模板的 id 名单在叶子模块 lib/platform-templates.ts 里，两边
// 都直接引它：不用谁在求值期把名单交给别人。

import { store } from "./store.ts";
import { PLATFORMS } from "./platform-templates.ts";
// 额度插件的登记表（lib/quota-plugins.ts）反过来要读这一层的平台表，所以这两
// 个模块是个环。环上的模块不能在求值期读别人的常量：这里只在函数里用它，
// 那里也不在求值期读这边的东西。
import { warnUnknownQuotaPlugin } from "./quota-plugins.ts";

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
  /** 以后允不允许自动拉覆盖这一份目录。 */
  auto: boolean;
  /** 上次拉目录的时刻（毫秒）。0 = 没拉过（手写的目录）。 */
  fetchedAt: number;
  /** 现在这份目录是哪来的：自动拉的，还是人写的。 */
  source: "auto" | "manual";
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

/** 模板的 id：代码里写死的那几个。表里的开放平台不能跟它们重名。 */
function isTemplateId(id: string): boolean {
  return PLATFORMS.some((p) => p.id === id);
}

/** 表里的全部开放平台，按 id 排。 */
export function listOpenPlatforms(): OpenPlatformRow[] {
  const rows = store()
    .prepare(
      "SELECT id, label, base_url, models, models_auto, quota_plugin, kind, region, created_at, updated_at " +
        "FROM platform ORDER BY id",
    )
    .all() as any[];
  return rows.map(toRow);
}

/** 某一个开放平台。没有就是 null。 */
export function openPlatformOf(id: string): OpenPlatformRow | null {
  const row = store()
    .prepare(
      "SELECT id, label, base_url, models, models_auto, quota_plugin, kind, region, created_at, updated_at " +
        "FROM platform WHERE id = ?",
    )
    .get(id) as any;
  return row ? toRow(row) : null;
}

/**
 * 加一个开放平台。
 *
 * id 必须是能放进路径里的那一段，而且不能跟网关自己的路径、代码里的模板
 * 或者已有的账号撞 —— 撞了的话这个平台就是死的：模板优先，表里那一行没人看；
 * 账号的 id 跟平台 id 共用一个命名空间，撞了面板分不清哪个是哪个。
 */
export function createOpenPlatform(input: {
  id: string;
  label: string;
  baseUrl: string;
  quotaPlugin?: string;
}): { ok: boolean; message: string } {
  const id = String(input.id ?? "").trim();
  const problem = checkId(id);
  if (problem) return { ok: false, message: problem };
  if (openPlatformOf(id)) return { ok: false, message: "已经有这个平台了" };
  const label = String(input.label ?? "").trim();
  if (!label) return { ok: false, message: "得有个名字" };
  const baseUrl = String(input.baseUrl ?? "").trim();
  const urlProblem = checkBaseUrl(baseUrl);
  if (urlProblem) return { ok: false, message: urlProblem };
  const now = Date.now();
  const models: OpenPlatformModels = { items: [], auto: true, fetchedAt: 0, source: "auto" };
  const quotaPlugin = String(input.quotaPlugin ?? "").trim();
  store()
    .prepare(
      "INSERT INTO platform (id, label, base_url, models, models_auto, quota_plugin, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      label,
      normalizeBaseUrl(baseUrl),
      modelsJson(models),
      models.auto ? 1 : 0,
      quotaPlugin,
      now,
      now,
    );
  // 填了额度插件却没人登记：说一声，但照样写进去 —— 用户可能先填 id 再让我们
  // 上线那个插件，拦下来反而让人没法保存。
  warnUnknownQuotaPlugin(id, quotaPlugin);
  return { ok: true, message: `加好了：${label}` };
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
    modelsAuto?: boolean;
    /**
     * 这份目录是哪来的：自动拉的（auto）还是人写的（manual）。
     *
     * 不给就是「manual」：写了目录而没说哪来的，那多半是人写的。
     */
    source?: "auto" | "manual";
    /** 上次拉目录的时刻（毫秒）。0 = 没拉过。 */
    fetchedAt?: number;
  },
): { ok: boolean; message: string } {
  // 代码里的平台改不了：它们不在表里，改了也是改一份没人看的东西。
  if (isTemplateId(id)) return { ok: false, message: "这个 id 是代码里的平台，改不了" };
  const row = openPlatformOf(id);
  if (!row) return { ok: false, message: `没有这个平台：${id}` };
  const label = patch.label === undefined ? row.label : String(patch.label).trim();
  if (!label) return { ok: false, message: "得有个名字" };
  const baseUrl = patch.baseUrl === undefined ? row.baseUrl : String(patch.baseUrl).trim();
  const urlProblem = checkBaseUrl(baseUrl);
  if (urlProblem) return { ok: false, message: urlProblem };
  // null 与没给是两回事：null 是「把这一格清空」，没给是「别动它」。
  const quotaPlugin = patch.quotaPlugin === undefined ? row.quotaPlugin : String(patch.quotaPlugin ?? "").trim();

  let models = row.models;
  if (patch.models !== undefined) {
    models = {
      items: normalizeModels(patch.models),
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

  store()
    .prepare(
      "UPDATE platform SET label = ?, base_url = ?, models = ?, models_auto = ?, quota_plugin = ?, updated_at = ? " +
        "WHERE id = ?",
    )
    .run(
      label,
      normalizeBaseUrl(baseUrl),
      modelsJson(models),
      models.auto ? 1 : 0,
      quotaPlugin,
      Date.now(),
      id,
    );
  // 填了额度插件却没人登记：说一声，但照样写进去（同 createOpenPlatform）。
  warnUnknownQuotaPlugin(id, quotaPlugin);
  return { ok: true, message: "改好了" };
}

/**
 * 删一个开放平台。
 *
 * 只删平台那一行：名下的账号与它们的凭据不归这一层管，级联由调用方负责
 * （那是账号层的事 —— 它才知道哪些凭据属于哪个账号）。调用方删平台之前
 * 必须自己把名下的账号删干净，否则那些账号就没有平台可挂了。
 */
export function deleteOpenPlatform(id: string): { ok: boolean; message: string } {
  // 代码里的平台删不了：删了就是删掉一段代码。
  if (isTemplateId(id)) return { ok: false, message: "这个 id 是代码里的平台，删不了" };
  const row = openPlatformOf(id);
  if (!row) return { ok: false, message: `没有这个平台：${id}` };
  store().prepare("DELETE FROM platform WHERE id = ?").run(id);
  return { ok: true, message: "删掉了" };
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/** 这个 id 能不能用。不能的话给一句人话。 */
function checkId(id: string): string | null {
  if (!id) return "得有个平台 id";
  if (!ID_PATTERN.test(id)) return "平台 id 只能用小写字母、数字与连字符";
  if (RESERVED_IDS.has(id)) return "这个 id 是网关自己用的，换一个";
  if (isTemplateId(id)) return "这个 id 已经是代码里的平台了，换一个";
  if (isAccountId(id)) return "这个 id 已经是一个账号了，换一个";
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

/** 地址能不能用。不能的话给一句人话。 */
function checkBaseUrl(value: string): string | null {
  if (!value) return "得有个地址";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "地址不对，得是完整的网址";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "地址只收 http 与 https";
  if (!url.hostname) return "地址里得有个主机名";
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
 * 整个目录是一个 JSON：模型名、上次什么时候拉的、哪来的。
 *
 * 自动不自动**不在**这个 JSON 里：那一格在 models_auto 列上（能查的那一格），
 * JSON 里再存一份，两份迟早会走样。早期存过的 JSON 里带着 auto，读的时候
 * 当它不存在。
 */
function modelsJson(models: OpenPlatformModels): string {
  return JSON.stringify({
    items: models.items,
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
  const empty: OpenPlatformModels = { items: [], auto, fetchedAt: 0, source: "auto" };
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw ?? ""));
  } catch {
    return empty;
  }
  if (Array.isArray(parsed)) {
    // 早期存的是单纯的模型名数组。
    return { items: normalizeModels(parsed), auto, fetchedAt: 0, source: "auto" };
  }
  if (!parsed || typeof parsed !== "object") return empty;
  return {
    items: normalizeModels(Array.isArray(parsed.items) ? parsed.items : []),
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
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}
