// lib/store.ts — where the credentials live: one SQLite file.
//
// Everything secret the gateway holds is in here: the sessions of the eight
// upstreams, the keys the clients authenticate with, the relay station's
// accounts, the salt the device fingerprint is derived from. The file itself
// is 0600, the same as the session files it replaces.
//
// Two more tables live beside them:
//   locks  one writer at a time, because a refresh token rotates on every
//          refresh and two writers would log each other out
//   cache  the snapshot /health serves, so it does not have to ask the
//          upstreams every time somebody looks
//
// And one that is not a secret:
//   config the settings, so the service reads them from here at startup
//          instead of from the environment, and a management panel can
//          write them
//
// Node 24 ships SQLite, so there is no native module to compile.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./paths.ts";
// 平台模板表（叶子模块，不引任何东西）：迁移要把那几行补进 platform 表。
import { isVendorTemplateKind, PLATFORM_TEMPLATES, SIMULATED_CLIENTS } from "./platform-catalog.ts";
// 播种用的模型目录：与各 kind 的代码目录同一个来源（见 seedPlatformModels）。
import { knownCatalogForBaseUrl } from "./model-catalog.ts";
import { QINIU_MODELS } from "./qiniu/models.ts";
import { TOKENRHYTHM_MODELS } from "./tokenrhythm/models.ts";
import { XINGHUO_MODELS } from "./xinghuo/models.ts";

/** What kind of secret a row holds. */
export type SecretKind = "session" | "key" | "account" | "salt";

export interface SecretRow {
  id: string;
  kind: string;
  data: any;
  updatedAt: number;
}

let db: DatabaseSync | null = null;

export { dbPath };

/**
 * The open database.
 *
 * A database that cannot be opened is a hard failure: the credentials are in
 * here, and carrying on without them would look like a lost login.
 */
export function store(): DatabaseSync {
  if (db) return db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    // An empty file is a valid new database, and creating it ourselves is the
    // only way to get the mode right.
    fs.writeFileSync(file, "", { mode: 0o600 });
  } else {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* not ours to change */
    }
  }
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // The aggregate catalog's targets hang off its models, and the database has
  // to know that to clean up after a model is deleted.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    `CREATE TABLE IF NOT EXISTS secrets (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS locks (
      id     TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      at     INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS cache (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      at   INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  // 账号：一行一个账号。`platform` 是平台 id（代码里的模板，或者表里的开放
  // 平台，也是请求路径里那一段），同一平台下可以有多行。
  db.exec(
    `CREATE TABLE IF NOT EXISTS provider (
      id         TEXT PRIMARY KEY,
      platform   TEXT NOT NULL,
      alias      TEXT NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1,
      weight     INTEGER NOT NULL DEFAULT 100,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  // 客户端会话 → 上游会话的映射。
  //
  // 客户端给的会话 id 什么样都有（pi 给裸 UUID，opencode 给 `ses_xxx`），
  // 而上游只认自己客户端那种形状。所以映射一次，落在这里：同一个客户端会话
  // 永远是同一个上游会话 id。
  db.exec(
    `CREATE TABLE IF NOT EXISTS session_map (
      upstream          TEXT NOT NULL,
      client_session_id TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      PRIMARY KEY (upstream, client_session_id)
    )`,
  );
  // 平台层的生效策略：一行一个平台，没有行就是默认。
  //
  // 这张表要在迁移之前就存在：迁移会把旧行上的策略搬进来。
  db.exec(
    `CREATE TABLE IF NOT EXISTS platform_policy (
      platform   TEXT PRIMARY KEY,
      policy     TEXT NOT NULL DEFAULT 'single',
      updated_at INTEGER NOT NULL
    )`,
  );
  // 开放平台：用户自己加的平台，一行一个。
  //
  // 代码里的模板（lib/platform-templates.ts）与这张表是两处数据源：模板优先 ——
  // 模板里有的 id，表里的那一行当没有。这样把模板加回代码时不用先清库，
  // 回滚是安全的。
  //
  // 这一张表的 `id` 就是**平台 id**：跟 provider.platform、
  // platform_policy.platform 是同一个东西 —— 请求路径里那一段
  // （`<平台>/v1/messages`）用的就是它。
  //
  // `models` 存的是整个目录（模型名、上次什么时候拉的、哪来的），
  // `models_auto` 是「以后允不允许自动拉覆盖」那一格 —— 自动不自动不在 JSON
  // 里（早期存过的那一份，忽略就是）。
  db.exec(
    `CREATE TABLE IF NOT EXISTS platform (
      id           TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      base_url     TEXT NOT NULL,
      models       TEXT NOT NULL DEFAULT '[]',
      models_auto  INTEGER NOT NULL DEFAULT 1,
      quota_plugin TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL DEFAULT 'openai',
      region       TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )`,
  );
  // 预置平台被删掉的墓碑：一行一个 id。
  //
  // 播种是「表里没有就补一行」，补不出「用户删过它」这件事 —— 删掉 minimax 的
  // 行，下次启动又插回一个空平台，等于删不掉。所以删的那一下在这里留一条，播种
  // 见到就跳过；用户自己把它建回来（createOpenPlatform）就把墓碑清掉。
  //
  // 只记预置目录（platform-catalog.ts 的 SIMULATED_CLIENTS）里的 id：用户自己建
  // 的平台没有播种这一层，删了本来就没了。
  db.exec(
    `CREATE TABLE IF NOT EXISTS platform_preset_removed (
      id         TEXT PRIMARY KEY,
      removed_at INTEGER NOT NULL
    )`,
  );
  // 人给某个模型的元数据：一行一个模型，只放**写了的**那些字段（JSON）。
  //
  // 平台一级一份：模板平台与开放平台共用这一张表 —— 目录的来源是两回事（有的
  // 是代码里的表，有的是上游拉回来的），人写的那一层是同一个意思。
  //
  // 主键是（平台, 模型 id）：同一个模型在一个平台下只能有一条，重复写就是覆盖
  // 自己；没有序号列，所以读出来的顺序是 model_id 的顺序 —— 稳定比「保存的先后」
  // 重要（发布出去的目录每次都得一样）。
  db.exec(
    `CREATE TABLE IF NOT EXISTS platform_model_override (
      platform_id TEXT NOT NULL,
      model_id    TEXT NOT NULL,
      data        TEXT NOT NULL,
      PRIMARY KEY (platform_id, model_id)
    )`,
  );
  // 账号的冷却：失败之后一段时间不再路由到那个账号。
  //
  // 落库：网关重启以后它还在 —— 一个刚被限流的账号不该因为重启又被试一次。
  // 过期是惰性的：判定的时候比时间就行，不需要定时器去「恢复」。
  db.exec(
    `CREATE TABLE IF NOT EXISTS cooldown (
      provider_id TEXT PRIMARY KEY,
      until_ms    INTEGER NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL
    )`,
  );
  migrateProviderToAccounts(db);
  migrateProviderWeight(db);
  migratePlatforms(db);
  // 模拟客户端那一族的平台行必须在任何 allPlatforms() 之前就位：代码里的
  // PLATFORMS 已经清空（lib/platform-templates.ts），表里没有的行等于平台不存在 ——
  // 路由、面板、额度、目录全都按表里的行找平台。
  migrateSimulatedClients(db);
  seedPlatformModels(db);
  migrateAccountIds(db);
  return db;
}

/**
 * 把旧的「一行一个上游」改成「一行一个账号」。
 *
 * 旧的行里 `kind` 的值基本上就是平台 id（`minimax`、`qoder`、`qoder-cn`……），
 * 但有两处要修：`workbuddy` 那一行的平台叫 `workbuddy-cn`，`qoder` 那一行要
 * 按 region 分成 `qoder`（全球区）与 `qoder-cn`（中国区）两个平台。
 *
 * 旧行的 `policy` 搬到平台层：一个平台下有多个账号时，取第一个不是默认值的
 * 那个——否则 TokenRhythm 的「余额到期优先」会默默丢掉。
 */
function migrateProviderToAccounts(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(provider)").all() as { name?: string }[];
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has("kind")) return; // 已经是新的形状了。

  const rows = db
    .prepare("SELECT id, kind, alias, enabled, region, created_at, updated_at FROM provider")
    .all() as any[];
  const policies = has("policy")
    ? (db.prepare("SELECT id, policy FROM provider").all() as any[])
    : [];

  db.exec("ALTER TABLE provider RENAME TO provider_old");
  db.exec(
    `CREATE TABLE provider (
      id         TEXT PRIMARY KEY,
      platform   TEXT NOT NULL,
      alias      TEXT NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1,
      weight     INTEGER NOT NULL DEFAULT 100,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  const insert = db.prepare(
    "INSERT INTO provider (id, platform, alias, enabled, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const setPolicy = db.prepare(
    "INSERT INTO platform_policy (platform, policy, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(platform) DO NOTHING",
  );
  const policyOf = new Map(policies.map((r) => [String(r.id), String(r.policy ?? "single")]));
  const now = Date.now();
  let order = 0;

  for (const row of rows) {
    const platform = platformOfLegacyRow(String(row.kind), String(row.region ?? ""));
    insert.run(
      String(row.id),
      platform,
      String(row.alias ?? ""),
      Number(row.enabled ?? 1) ? 1 : 0,
      // 旧行没有权重：按创建先后给一个递减的，顺序跟从前一样。
      100 - order * 10,
      Number(row.created_at ?? now),
      Number(row.updated_at ?? now),
    );
    order++;
    const policy = policyOf.get(String(row.id));
    if (policy && policy !== "single") setPolicy.run(platform, policy, now);
  }
  db.exec("DROP TABLE provider_old");
}

/**
 * 权重这一列是后来加的：旧的账号行没有它，先补上。
 *
 * 补的默认值按创建先后递减（第一个 100、第二个 90……），这样顺序跟从前一样，
 * 面板上再让人调。
 */
function migrateProviderWeight(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(provider)").all() as { name?: string }[];
  if (columns.some((c) => c.name === "weight")) return;
  db.exec("ALTER TABLE provider ADD COLUMN weight INTEGER NOT NULL DEFAULT 100");
  const rows = db
    .prepare("SELECT id, platform FROM provider ORDER BY platform, created_at, id")
    .all() as { id?: string; platform?: string }[];
  const perPlatform = new Map<string, number>();
  const set = db.prepare("UPDATE provider SET weight = ? WHERE id = ?");
  for (const row of rows) {
    const platform = String(row.platform ?? "");
    const order = perPlatform.get(platform) ?? 0;
    perPlatform.set(platform, order + 1);
    set.run(100 - order * 10, String(row.id));
  }
}


/**
 * 平台表的两件迁移：补两列，再把那几行模板补进去。
 *
 * 导出：测试要能单独再跑一次（老库模拟），迁移本身得能被调用。
 */
export function migratePlatforms(db: DatabaseSync): void {
  migratePlatformColumns(db);
  seedPlatformTemplates(db);
  migratePlatformQuotaPlugins(db);
}

/**
 * 表里的平台那一格 `kind` 说它是通用开放平台时用的名字。
 *
 * 与 lib/open-platforms.ts 的 OPEN_PLATFORM_KIND_NAME 是同一个值 —— 从那边
 * 取会绕成环（那一层引这一层），所以写在这里，只此一处。
 */
const OPEN_PLATFORM_KIND = "openai";

/**
 * 目录归上游管的 kind：它们的模型清单只有上游报得出来，缓存表是按平台存的那一份。
 *
 * 写在这一层：播种要按它决定 `models_auto`（见 seedPlatformModels），而拿上游那份
 * 覆盖平台行的闸门（lib/open-platforms.ts 的 syncPlatformModels）也要问同一件事。
 * 两处各写一份名单，早晚会漂成一个写死、一个还能被盖。
 *
 * 其余几家不在名单里：七牛云、讯飞星火、TokenRhythm 的目录是代码挑过的一份（上游
 * 那份更宽，七牛报 78 个模型），方言类（openai / anthropic）的目录由面板那条路管。
 */
export const UPSTREAM_CATALOG_KINDS: ReadonlySet<string> = new Set(["sensenova", "intern-ai"]);

/**
 * 播种用的目录：按 kind 分，与各 kind 的**代码目录**同一个来源。
 *
 * 不调 kindOf(kind).models()：注册表要靠各平台模块求值才登记，而这一层是最低
 * 层（引 lib/kinds/index.ts 会把各家平台都拖进来，绕成环）。所以取的是那些
 * 模块自己的常量表 —— 同一份数据，换个入口读。测试对着 kind.models() 逐条比，
 * 两边走样就会红。
 *
 * SenseNova 与书生·端砚没有代码里的目录：它们的目录是从上游拉的，落在 cache
 * 表里。那两家就读 cache 那一行 —— 搬的是「现在正在服务的那份」，不是另造
 * 一份事实。cache 里还没有就是空（全新库的正常形态），不报错、不告警。
 */
const SEEDED_MODEL_IDS: Record<string, (db: DatabaseSync) => string[]> = {
  qiniu: () => QINIU_MODELS.map((model) => model.id),
  xinghuo: () => XINGHUO_MODELS.map((model) => model.id),
  tokenrhythm: () => TOKENRHYTHM_MODELS.map((model) => model.id),
  sensenova: (db) => cachedModelIds(db, "sensenova:catalog"),
  "intern-ai": (db) => cachedModelIds(db, "intern-ai:catalog"),
};

/** cache 表里那一份目录的模型 id。没有那一行、读不出来都是空数组。 */
function cachedModelIds(db: DatabaseSync, id: string): string[] {
  const row = db.prepare("SELECT data FROM cache WHERE id = ?").get(id) as
    | { data?: string }
    | undefined;
  if (!row?.data) return [];
  try {
    const parsed = JSON.parse(row.data) as { items?: unknown } | null;
    if (!Array.isArray(parsed?.items)) return [];
    // cache 里存的是上游报的那一行原样（对象），不是名字：这里取它的 id。
    return normalizeSeedIds(
      parsed.items.map((item) =>
        item && typeof item === "object" ? (item as { id?: unknown }).id : item,
      ),
    );
  } catch {
    return [];
  }
}

/** 模型名：去空的、去重号的。与读目录那一层同一个口径。 */
function normalizeSeedIds(items: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const name = String(raw ?? "").trim();
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 这一行的目录现在有什么（认不出来的形状当空）。 */
function seededCurrentIds(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "")) as any;
    // 早期存的是单纯的模型名数组。
    if (Array.isArray(parsed)) return normalizeSeedIds(parsed);
    if (!parsed || typeof parsed !== "object") return [];
    return normalizeSeedIds(Array.isArray(parsed.items) ? parsed.items : []);
  } catch {
    return [];
  }
}

/**
 * 这一行的目录是不是播种写进去的那一份：`source` 不是 manual，`fetchedAt` 是 0。
 *
 * 区分「代码搬进去的」与「人写的 / 从上游拉的」：只有前者可以被播种顺手改成
 * 「不自动拉」。
 */
function isSeededCatalog(raw: unknown): boolean {
  try {
    const parsed = JSON.parse(String(raw ?? "")) as any;
    // 早期存的是单纯的模型名数组：读出来就是 auto + 没拉过。
    if (Array.isArray(parsed)) return true;
    if (!parsed || typeof parsed !== "object") return false;
    return parsed.source !== "manual" && Number(parsed.fetchedAt ?? 0) === 0;
  } catch {
    return false;
  }
}

/**
 * 把平台行自己的模型目录播种出来。
 *
 * 以前这些行的 models 是空的，而它们各自是哪个模型只有代码知道（七牛、星火、
 * TokenRhythm 的常量表），或者只有上游缓存里那一份（SenseNova、端砚）。空的
 * 目录对开放平台是合法状态，但对这几家意味着平台在面板上看不见 —— 把手上已经
 * 有的那一份搬进去。
 *
 * 只填**空着的**：已经有内容的那一行要么是用户手写的，要么是上游拉回来的，都不
 * 能动。`models_auto` 关着的也不填：那一格说的是「以后别自动往里写」，而播种
 * 也是一次自动写入。人把目录清空是明确的意思，不该被重启填回来。
 *
 * 写的不是从上游拉的那一份：`source` 记 auto、`fetchedAt` 留 0（没拉过）—— 0
 * 就是「没拉过」的意思，写成现在会让目录看起来刚拉过，半小时内不再去问上游。
 *
 * `models_auto` 按「这一行的目录归谁管」写（见 UPSTREAM_CATALOG_KINDS）：
 *
 *   七牛云、讯飞星火、TokenRhythm  关掉。它们的目录是代码挑过的一份，上游那份
 *     更宽（七牛报 78 个模型），拿它盖上来会出现被上游拒的模型。
 *   SenseNova、书生·端砚           开着。这两家没有代码目录，目录只有上游报得
 *     出来 —— 关掉就等于永远停在播种那一刻的那份。
 *   方言类（openai / anthropic）    开着，它们的目录本来就是上游（或人）说了算。
 *
 * 那一格是**面板上那个开关**，写错就是开关说了不算：人关掉它，后台照写。
 *
 * 幂等：填过的行目录非空，再跑一次连 updated_at 都不动。返回填了几行。
 */
export function seedPlatformModels(db: DatabaseSync): number {
  const rows = db
    .prepare("SELECT id, kind, base_url, models, models_auto FROM platform")
    .all() as { id?: string; kind?: string; base_url?: string; models?: unknown; models_auto?: unknown }[];
  const fill = db.prepare("UPDATE platform SET models = ?, models_auto = ?, updated_at = ? WHERE id = ?");
  // 只翻那一格：目录不动 —— 已经有内容的是人写的或从上游拉回来的，不能碰。
  const stopAuto = db.prepare("UPDATE platform SET models_auto = 0, updated_at = ? WHERE id = ?");
  const now = Date.now();
  let seeded = 0;
  for (const row of rows) {
    const id = String(row.id ?? "");
    if (!id) continue;
    if (Number(row.models_auto ?? 1) === 0) continue;
    const kind = String(row.kind ?? "").trim() || OPEN_PLATFORM_KIND;
    const vendor = isVendorTemplateKind(kind);
    if (seededCurrentIds(row.models).length) {
      // 已有目录：人写的或上游拉的，不动。
      //
      // 例外是厂商模板行上**播种自己写进去的**那一份（source=auto、没拉过）：
      // 老库里那几行是播种改口径之前写进去的，models_auto 还是 1 —— 补上这一格，
      // 它们就不必等下一次「目录被上游那份盖掉」才被发现。
      if (vendor && !UPSTREAM_CATALOG_KINDS.has(kind) && isSeededCatalog(row.models)) stopAuto.run(now, id);
      continue;
    }
    // 通用开放平台：这一行背后是哪家厂商由地址说明（lib/model-catalog.ts）。
    // 表里没有这家厂商就是空 —— 用户在面板上手填，不是错误。
    const items =
      kind === OPEN_PLATFORM_KIND
        ? normalizeSeedIds(knownCatalogForBaseUrl(String(row.base_url ?? ""))?.models.map((m) => m.id) ?? [])
        : (SEEDED_MODEL_IDS[kind]?.(db) ?? []);
    if (!items.length) continue;
    const auto = vendor && !UPSTREAM_CATALOG_KINDS.has(kind) ? 0 : 1;
    fill.run(JSON.stringify({ items, fetchedAt: 0, source: "auto" }), auto, now, id);
    seeded++;
  }
  return seeded;
}

/**
 * 三家插件平台的默认额度插件补进已有的行。
 *
 * 模板里现在写着插件 id（lib/platform-catalog.ts），但已有的库里那几行是空的：
 * 当初补进表时不带插件。补的只有**空着的**那一格 —— 用户自己选过的插件（比如
 * 七牛换了一个门户插件）不能被启动时的迁移改掉。
 *
 * 幂等：值非空的行不 UPDATE，所以再跑一次连 updated_at 都不动。
 */
export function migratePlatformQuotaPlugins(db: DatabaseSync): void {
  const set = db.prepare(
    "UPDATE platform SET quota_plugin = ?, updated_at = ? WHERE id = ? AND TRIM(quota_plugin) = ''",
  );
  const now = Date.now();
  // 三行要么都补上要么都不补：补到一半的话，重启后剩下的那几家会看着像「这个
  // 平台没额度插件」—— 那是错的话，比不补更糟。
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const t of PLATFORM_TEMPLATES) {
      // 七牛的用户自己选插件，星火没有接口：模板里空着的就不补。
      if (!t.quotaPlugin) continue;
      set.run(t.quotaPlugin, now, t.suggestedId);
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已经没了 */
    }
    throw new Error(
      `额度插件的迁移失败：${(e as Error)?.message ?? String(e)}。事务已整个回滚，没有平台的额度插件被改。`,
    );
  }
}

/**
 * 平台表补两列：kind 与 region。
 *
 * `kind` 是「怎么跟它说话」（kind 注册表里的那一类），`region` 是「在哪个区域」。
 * 这两样以前只存在于代码里的模板（lib/platform-templates.ts），平台迁进表里就得
 * 有地方放。旧库没有这两列：补上，缺的那一列按缺省算（kind 是 openai ——
 * 表里那些行都是用户自己加的开放平台；region 是空串）。
 */
function migratePlatformColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(platform)").all() as { name?: string }[];
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has("kind")) db.exec("ALTER TABLE platform ADD COLUMN kind TEXT NOT NULL DEFAULT 'openai'");
  if (!has("region")) db.exec("ALTER TABLE platform ADD COLUMN region TEXT NOT NULL DEFAULT ''");
}

/**
 * 把那五个还没迁完的平台补成表里的行。
 *
 * 幂等：已经有的行不动（INSERT OR IGNORE）—— 用户改过的名字与地址不能被启动
 * 时的迁移顺手抹掉。模型目录是空的（自动拉，让上游自己报）；额度插件填模板里
 * 那一个（三家插件的额度只有插件问得到，七牛与星火是空串）。
 */
function seedPlatformTemplates(db: DatabaseSync): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO platform " +
      "(id, label, base_url, models, models_auto, quota_plugin, kind, region, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
  );
  const now = Date.now();
  for (const t of PLATFORM_TEMPLATES) {
    insert.run(
      t.suggestedId,
      t.label,
      t.defaultBaseUrl,
      // 空的目录（跟 createOpenPlatform 写进去的形状一样：auto 那一格在列上，
      // JSON 里只有模型名、上次拉的时刻与来源）。
      JSON.stringify({ items: [], fetchedAt: 0, source: "auto" }),
      t.quotaPlugin,
      t.kind,
      t.region,
      now,
      now,
    );
  }
}

/**
 * 模拟客户端那一族的平台补成表里的行。
 *
 * 必须在启动时播完，不能等第一次用到再建：PLATFORMS 已经清空
 * （lib/platform-templates.ts），表里没有的行就等于这个平台不存在 —— 路由、面板、
 * 额度、目录全都按表里的行找平台。少一行，那个客户端的请求就整条路断掉。
 *
 * 只播 `hidden === false` 的：hidden 是「目录里先备着、面板上还不给」。播出来就是
 * 一个地址空、目录空、额度空的平台，面板上看得见却用不了 —— 那样 hidden 就没意义
 * 了。将来把它改成 false，下一次启动自然就播。
 *
 * 删过的不播（platform_preset_removed 的墓碑）：删了就是没了，重启不该插回来。
 * 用户自己建回来会清墓碑（lib/open-platforms.ts 的 createOpenPlatform）。
 *
 * 幂等：存在就不插，已经有的行一个字段都不改 —— 名字用户在面板上能改，那是用户
 * 的值；目录与额度插件归别处维护，重启不该把它们拨回去。
 *
 * 判存在与判墓碑都在同一条语句里（INSERT … SELECT … WHERE NOT EXISTS），不再有
 * 两次读之间的窗口：先读墓碑、再读平台行、再插，中间别人写一条墓碑或建一行，播
 * 出来就是「删掉的长回来了」或者「盖掉用户刚建的行」。一句里判完，窗口就没了。
 *
 * `models_auto` 是 0：模拟客户端的目录是代码里挑过的一份（各 kind 自己的
 * models()），不从上游拉 —— 上游那份是那个封闭客户端的目录，网关拿不到也不该拿。
 */
export function migrateSimulatedClients(db: DatabaseSync): void {
  const insert = db.prepare(
    "INSERT INTO platform " +
      "(id, label, base_url, models, models_auto, quota_plugin, kind, region, created_at, updated_at) " +
      "SELECT ?, ?, '', '[]', 0, '', ?, ?, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM platform_preset_removed WHERE id = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM platform WHERE id = ?)",
  );
  const now = Date.now();
  for (const client of SIMULATED_CLIENTS) {
    // hidden 是目录数据（「面板上还不给」），不是库里的状态，留在 JS 这一层判。
    if (client.hidden) continue;
    insert.run(client.id, client.label, client.kind, client.region, now, now, client.id, client.id);
  }
}

/**
 * 这个预置平台是不是被用户删掉了。
 *
 * 只有播种与面板的删除/新建用得着：判断一个 id 在不在表里用 openPlatformOf。
 */
export function platformPresetRemoved(id: string): boolean {
  return store().prepare("SELECT id FROM platform_preset_removed WHERE id = ?").get(id) !== undefined;
}

/**
 * 记下「用户删掉了这个预置平台」。
 *
 * 与删平台那一行写在同一个事务里（调用方已经开着的那个）：两句话之间断掉，
 * 就会出现「行删了、墓碑没写，重启又长回来」。
 */
export function rememberPlatformPresetRemoved(id: string): void {
  store()
    .prepare("INSERT OR REPLACE INTO platform_preset_removed (id, removed_at) VALUES (?, ?)")
    .run(id, Date.now());
}

/**
 * 用户把这个 id 建回来了，把墓碑清掉。
 *
 * 不清的话，这一行哪天再被删一次也无所谓 —— 问题在下次建的时候：播种见到墓碑就
 * 跳过，可那一行是用户自己建的、归用户，墓碑留着只会误导后来读这张表的人。
 */
export function forgetPlatformPresetRemoved(id: string): void {
  store().prepare("DELETE FROM platform_preset_removed WHERE id = ?").run(id);
}

/**
 * 账号 id 从「平台名」换成数字。 *
 * 账号 id 现在是一个自增整数（lib/providers.ts 的 nextAccountId），面板只显示
 * alias，所以换号对使用者不可见 —— 但凭据与冷却都按 id 认人，得跟着搬。老库里
 * 还是「平台名」形态（`tokenrhythm`、`qoder`、`workbuddy-cn`），启动时换掉。
 *
 * 幂等：全是数字就整段跳过。
 *
 * 一个事务里改四样：行上的 id、alias、凭据的 id、冷却。中途任何一步抛错就整个
 * 回滚并把错误抛出去 —— 网关宁可起不来，也不能带着「一半账号换了号、另一半还
 * 是旧号」的库对外服务：那会把凭据接到不相干的账号上。
 */
export function migrateAccountIds(db: DatabaseSync): void {
  const rows = db.prepare("SELECT id, alias, created_at FROM provider").all() as {
    id?: string;
    alias?: string;
    created_at?: number;
  }[];
  if (!rows.some((row) => !/^\d+$/.test(String(row.id)))) return;

  // 编号：按建出来的先后（同一时刻再按 id），从现有最大数字往后接 —— 老库里
  // 可能已经有数字 id（新装的库就是），接着排才不会撞号；也不填空洞，删掉的号
  // 不再发放。
  const ordered = [...rows].sort((a, b) => {
    const byTime = Number(a.created_at ?? 0) - Number(b.created_at ?? 0);
    return byTime !== 0 ? byTime : String(a.id).localeCompare(String(b.id));
  });
  let next = 1;
  for (const row of rows) {
    const id = String(row.id);
    if (/^\d+$/.test(id)) next = Math.max(next, Number(id) + 1);
  }
  const mapping = new Map<string, string>();
  for (const row of ordered) {
    const old = String(row.id);
    if (/^\d+$/.test(old)) continue;
    mapping.set(old, String(next++));
  }

  let step = "开事务";
  try {
    db.exec("BEGIN IMMEDIATE");
    // 1. 行上的 id 换号。alias 只在空的时候补旧 id：生产上有人把账号改名成
    //    「中转站 1」，那个名字不能被旧 id 盖掉。
    step = "账号行";
    const renameRow = db.prepare(
      "UPDATE provider SET id = ?, alias = CASE WHEN alias = '' THEN ? ELSE alias END WHERE id = ?",
    );
    for (const [old, fresh] of mapping) renameRow.run(fresh, old, old);
    // 2. 凭据：四种前缀都按冒号边界换中间那一段。
    step = "凭据";
    const secrets = db.prepare("SELECT id FROM secrets").all() as { id?: string }[];
    const renameSecret = db.prepare("UPDATE secrets SET id = ? WHERE id = ?");
    for (const row of secrets) {
      const id = String(row.id);
      const fresh = renamedSecretId(id, mapping);
      if (fresh) renameSecret.run(fresh, id);
    }
    // 3. 冷却：按账号 id 记的，跟着换。
    step = "冷却";
    const renameCooldown = db.prepare("UPDATE cooldown SET provider_id = ? WHERE provider_id = ?");
    for (const [old, fresh] of mapping) renameCooldown.run(fresh, old);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已经没了 */
    }
    throw new Error(
      `账号 id 迁移在「${step}」这一步失败：${(e as Error)?.message ?? String(e)}。` +
        `事务已整个回滚，没有账号被换号；库还是迁移前的样子。`,
    );
  }
}

/**
 * 凭据 id 跟着账号换号。
 *
 * 四种形态：`session:provider:<id>`、`key:provider:<id>`、
 * `key:provider:<id>:<后缀>`、`account:<id>[:<后缀>]`。边界是冒号 ——
 * `key:provider:qoder` 不能把 `key:provider:qoder-cn:…` 一起改掉，那是另一个
 * 账号的凭据。映射里没有的账号（行已经被删掉、凭据留下）原样不动。
 */
function renamedSecretId(id: string, mapping: Map<string, string>): string | null {
  const parts = id.split(":");
  const rebase = (index: number): string | null => {
    const fresh = mapping.get(parts[index] ?? "");
    if (!fresh) return null;
    return [...parts.slice(0, index), fresh, ...parts.slice(index + 1)].join(":");
  };
  if (parts[0] === "session" && parts[1] === "provider" && parts.length === 3) return rebase(2);
  if (parts[0] === "key" && parts[1] === "provider" && parts.length >= 3) return rebase(2);
  if (parts[0] === "account" && parts.length >= 2) return rebase(1);
  return null;
}

/** 旧行（kind + region）属于哪个平台。 */
function platformOfLegacyRow(kind: string, region: string): string {
  if (kind === "workbuddy") return "workbuddy-cn";
  if (kind === "qoder") return region === "cn" ? "qoder-cn" : "qoder";
  return kind;
}

/* ------------------------------------------------------------------ *
 * The secrets
 * ------------------------------------------------------------------ */

/** Read a secret; a broken row counts as no secret. */
export function getSecret<T>(id: string): T | null {
  const row = store().prepare("SELECT data FROM secrets WHERE id = ?").get(id) as
    | { data?: string }
    | undefined;
  if (!row?.data) return null;
  try {
    const parsed = JSON.parse(row.data);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/** Write a secret. */
export function setSecret(id: string, kind: SecretKind, data: unknown): void {
  store()
    .prepare(
      "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, " +
        "updated_at = excluded.updated_at",
    )
    .run(id, kind, JSON.stringify(data), Date.now());
}

/** Forget a secret — the way back to a fresh login. */
export function deleteSecret(id: string): void {
  store().prepare("DELETE FROM secrets WHERE id = ?").run(id);
}

/* ------------------------------------------------------------------ *
 * The deleted providers
 * ------------------------------------------------------------------ */

/** A provider the operator deleted: it stays deleted. */
export function markProviderDeleted(id: string): void {
  store()
    .prepare("INSERT INTO deleted_provider (id, deleted_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
    .run(id, Date.now());
}

/** Was this provider deleted? */
export function providerDeleted(id: string): boolean {
  const row = store().prepare("SELECT id FROM deleted_provider WHERE id = ?").get(id);
  return row !== undefined;
}

/** Every secret whose id starts with the prefix. */
export function listSecrets(prefix = ""): SecretRow[] {
  const rows = store()
    .prepare("SELECT id, kind, data, updated_at FROM secrets WHERE id LIKE ? ORDER BY id")
    .all(`${prefix.replace(/[%_]/g, "")}%`) as any[];
  return rows.map((r) => {
    let data: any = null;
    try {
      data = JSON.parse(r.data);
    } catch {
      data = null;
    }
    return { id: r.id, kind: r.kind, data, updatedAt: Number(r.updated_at) };
  });
}

/* ------------------------------------------------------------------ *
 * The settings
 * ------------------------------------------------------------------ */

/** One setting, and when it was last written. */
export interface ConfigRow {
  key: string;
  value: string;
  updatedAt: number;
}

/**
 * A setting that was written to the database.
 *
 * The environment is the fallback: the deployment still sets what it always
 * did, and the database is where a panel writes a change. `null` means the
 * database has nothing to say about this key.
 */
export function getConfig(key: string): string | null {
  const row = store().prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

/** Write a setting to the database. */
export function setConfig(key: string, value: string): void {
  store()
    .prepare(
      "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, value, Date.now());
}

/** Forget a setting — back to whatever the environment says. */
export function deleteConfig(key: string): void {
  store().prepare("DELETE FROM config WHERE key = ?").run(key);
}

/** Every setting the database holds. */
export function listConfig(): ConfigRow[] {
  const rows = store()
    .prepare("SELECT key, value, updated_at FROM config ORDER BY key")
    .all() as any[];
  return rows.map((r) => ({ key: String(r.key), value: String(r.value), updatedAt: Number(r.updated_at) }));
}

/* ------------------------------------------------------------------ *
 * The cache
 * ------------------------------------------------------------------ */

/** A cached value, with the time it was written. */
export interface Cached<T> {
  data: T;
  at: number;
}

/** The cached value, if it is not older than the given age. */
function getCached<T>(id: string, maxAgeMs: number): Cached<T> | null {
  const row = store().prepare("SELECT data, at FROM cache WHERE id = ?").get(id) as
    | { data?: string; at?: number }
    | undefined;
  if (!row?.data) return null;
  const at = Number(row.at ?? 0);
  if (maxAgeMs >= 0 && Date.now() - at > maxAgeMs) return null;
  try {
    return { data: JSON.parse(row.data) as T, at };
  } catch {
    return null;
  }
}

/** The cached value, however old it is. */
export function peekCached<T>(id: string): Cached<T> | null {
  return getCached<T>(id, -1);
}

/** Write a cached value. */
export function setCached(id: string, data: unknown): void {
  store()
    .prepare(
      "INSERT INTO cache (id, data, at) VALUES (?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data, at = excluded.at",
    )
    .run(id, JSON.stringify(data), Date.now());
}

/** The cached rows whose id starts with the prefix. */
export function listCached(prefix = ""): { id: string; at: number }[] {
  const rows = store()
    .prepare("SELECT id, at FROM cache WHERE id LIKE ? ORDER BY at")
    .all(`${prefix}%`) as { id?: string; at?: number }[];
  return rows.map((row) => ({ id: String(row.id ?? ""), at: Number(row.at ?? 0) }));
}

/** Forget a cached value. */
export function deleteCached(id: string): void {
  store().prepare("DELETE FROM cache WHERE id = ?").run(id);
}

/* ------------------------------------------------------------------ *
 * The lock
 * ------------------------------------------------------------------ */

/** A lock older than this counts as abandoned. */
const LOCK_STALE_MS = 30_000;

/** The lock could not be taken: somebody else is mid-refresh. */
export class LockUnavailableError extends Error {}

/**
 * Single writer around a refresh.
 *
 * Two holders of the same refresh token would rotate it twice and one of them
 * would be logged out, so a refresh takes this lock first. The other writer
 * waits; when the lock is gone it reads the session and finds the fresh token.
 */
export async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  let acquired = false;
  for (let i = 0; i < 3 && !acquired; i++) {
    try {
      store()
        .prepare("INSERT INTO locks (id, holder, at) VALUES (?, ?, ?)")
        .run(id, String(process.pid), Date.now());
      acquired = true;
    } catch (e) {
      const message = String((e as Error)?.message ?? "");
      if (!message.includes("UNIQUE") && !message.includes("constraint")) throw e;
      const row = store().prepare("SELECT at FROM locks WHERE id = ?").get(id) as { at?: number } | undefined;
      const age = row?.at ? Date.now() - Number(row.at) : LOCK_STALE_MS;
      if (age > LOCK_STALE_MS) {
        try {
          store().prepare("DELETE FROM locks WHERE id = ?").run(id);
        } catch {
          /* someone else won the race */
        }
        continue;
      }
      // Another writer is mid-refresh: wait for its result instead of racing it.
      await new Promise((r) => setTimeout(r, Math.min(LOCK_STALE_MS - age, 2000)));
    }
  }
  if (!acquired) {
    throw new LockUnavailableError(`could not acquire the credential lock (${id})`);
  }
  try {
    return await fn();
  } finally {
    try {
      store().prepare("DELETE FROM locks WHERE id = ?").run(id);
    } catch {
      /* already gone */
    }
  }
}

/** Close the database — only for the tools that open it and are done. */
export function closeStore(): void {
  try {
    db?.close();
  } catch {
    /* nothing to close */
  }
  db = null;
}
