// test/open-platform-admin-check.ts — 开放平台的面板接口：五个方法与列表里的三个新字段。
//
//   node --experimental-strip-types test/open-platform-admin-check.ts
//
// 离线：临时数据目录 + 本进程里的假上游，不发真请求，不碰真凭据。
//
// 这里查的是：
//
//   1. AddPlatform：加得进去、库里的行数多一行、ListUpstreams 里有它
//      （isOpenPlatform）、没有账号时状态是「没有凭据」
//   2. AddPlatform 的三种拒绝：id 不合法、跟代码模板重名、重复建（答复里没有
//      SQL 英文）
//   3. UpdatePlatform：改名生效、地址空串被拒且库没变、额度插件写进去、
//      手工目录（models_auto=false + 清单）写进去
//   3b. base_url / quota_plugin 带 presence：没给的格不动（只改名不会把额度插件
//      抹掉），显式空串才清空
//   4. DeletePlatform：平台行、账号、凭据都清掉，ListUpstreams 里不再出现；
//      模板平台删不掉
//   5. RefreshPlatformModels：假上游答了目录就是它；上游答 500 时保留原来那份
//   6. ListQuotaPlugins：七牛那个插件与它要的那一段凭据
//   7. SetPlatformPolicy 对开放平台生效
//   8. ListUpstreams 的三个新字段在模板平台上的取值
//   9. ListUpstreams 的模型目录三格（models / models_source /
//      models_fetched_at_ms）：开放平台报的是平台行里的那份，模板平台是空
//  10. ListUpstreams 的地址：开放平台还没加账号时报的是建的时候填的地址，
//      模板平台照旧（从名下账号的 kind 算）
//  11. 建平台时选类型：带 kind 的按那个建、不带的是 openai、没登记的那一类
//      （厂商那几家）据收、建好之后换不了类型
//  12. ListPlatformKinds：两族（先方言后模拟客户端）、方言两条与目录一致、
//      模拟客户端那几条的 preset_id / region 与目录一致、zcode 不在答复里
//  13. AddPlatform / UpdatePlatform 对预置的模拟客户端：id 由预置定死、
//      hidden 的不给建（答复不指向空列表）、改名不用送地址
//  14. ListUpstreams 的 from_row：表里有那一行的平台（模拟客户端与自建平台）
//      都是 true，而模拟客户端那几格（地址 / 额度插件 / 自动拉）照旧是空的
//      —— 两个判据不是同一个问题
//  15. ListUpstreams 的 models_from_upstream：逐 kind 的答案（方言类与
//      SenseNova / 端砚 true；七牛 / 星火 / TokenRhythm 与模拟客户端 false）
//      —— 面板照这一格给刷新按钮，不再去 ListPlatformKinds 里猜
//  16. 目录写不进去：models / modelsAuto 那几格在写入口（数据层）被
//      忽略（不报错，按现值留着），同一单里别的格照常保存；面板那条路端到端
//      也写不坏；同一格在开放平台上照常生效（对照组）
//
// 断言里不写死平台的个数：一律跟表里的行数比。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "open-platform-admin-"));
process.env.BUDDY_DATA_DIR = tmp;

const { adminService } = await import("../lib/admin/service.ts");
const { store, migrateSimulatedClients, platformPresetRemoved, forgetPlatformPresetRemoved } =
  await import("../lib/store.ts");
const { openPlatformOf, updateOpenPlatform } = await import("../lib/open-platforms.ts");
const { PLATFORM_KIND_OPTIONS, SIMULATED_CLIENTS, platformKindChoices } = await import(
  "../lib/platform-catalog.ts"
);
const { addAccount } = await import("../lib/providers.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { platformCategoryOfKind } = await import("../lib/platform-catalog.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { upstreamBaseUrl } = await import("../lib/admin/upstreams.ts");
const { PLATFORMS } = await import("../lib/platform-templates.ts");
const { saveAggregateModel, reloadAggregate } = await import("../lib/aggregate.ts");
const {
  ProviderPolicy,
  UnpublishedReason,
  UpstreamState,
} = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/**
 * 打印一个值：答复里有 bigint（时间戳），JSON.stringify 存不下。
 */
function show(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)) ?? String(value)
  );
}

/* ------------------------------------------------------------------ *
 * 失败怎么断言
 *
 * 失败不是「成功的答复里写着 false」，而是一次 Connect 错误：状态码按语义，
 * 机器码在响应头 buddy-error 上。所以断言分两半：
 *
 *   guard（一次调用）：抛了就回 null，并把那一条错误留给下面两个读数
 *   errCode（）：机器码（常量，不写字符串字面量：写错了名字要编译不过）
 *   errStatus（）：状态码
 *
 * 不断言错误消息里的中文：文案在面板那一侧，这里再写一份就是第二份真相。
 * ------------------------------------------------------------------ */

const { ConnectError } = await import("@connectrpc/connect");
const errorCodes = await import("../lib/admin/error-codes.ts");
const ADMIN_ERROR_HEADER = errorCodes.ADMIN_ERROR_HEADER;

/** 上一条错误。guard 每次开头清掉，读数的人看到的就是刚那一次的。 */
let lastError: InstanceType<typeof ConnectError> | null = null;

/**
 * 打一次：成功就给答复，失败就给 null。
 *
 * 不是 ConnectError 的错原样抛 —— 那种是测试自己写坏了（TypeError），吞掉就
 * 变成一条莫名的断言失败。
 */
async function guard<T>(run: () => Promise<T>): Promise<T | null> {
  lastError = null;
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ConnectError)) throw e;
    lastError = e;
    return null;
  }
}

/** 上一次失败的机器码。没有失败就是空串。 */
function errCode(): string {
  return String(lastError?.metadata.get(ADMIN_ERROR_HEADER) ?? "");
}

/** 上一次失败的状态码。没有失败就是 -1。 */
function errStatus(): number {
  return lastError?.code ?? -1;
}

/** 上一次失败的细节（排查用的事实，不是给用户的文案）。 */
function errDetail(): string {
  return String(lastError?.rawMessage ?? "");
}

/* ------------------------------------------------------------------ *
 * 服务写的日志
 *
 * 成功答复里没有 message 了，所以「连带删掉了什么」这类回执只剩日志一处。抓一份
 * 下来给断言看：光转发不改输出，跑起来还是原来那些行。
 * ------------------------------------------------------------------ */

const logLines: string[] = [];
const realLog = console.log.bind(console);
console.log = (...args: unknown[]): void => {
  logLines.push(args.map((one) => String(one)).join(" "));
  realLog(...args);
};

/** 到目前为止服务写过的日志。 */
function routerLog(): string {
  return logLines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 直接调服务（不起网关：这个测试看的是方法答什么，不是 HTTP 那层）
 * ------------------------------------------------------------------ */

const svc = adminService as any;

async function addPlatform(request: Record<string, unknown>): Promise<any> {
  return svc.addPlatform(request, {});
}

async function updatePlatform(request: Record<string, unknown>): Promise<any> {
  return svc.updatePlatform(request, {});
}

async function deletePlatform(request: Record<string, unknown>): Promise<any> {
  return svc.deletePlatform(request, {});
}

async function refreshPlatformModels(request: Record<string, unknown>): Promise<any> {
  return svc.refreshPlatformModels(request, {});
}

async function listQuotaPlugins(): Promise<any> {
  return svc.listQuotaPlugins({});
}

async function listPlatformKinds(): Promise<any[]> {
  const res = await svc.listPlatformKinds({}, {});
  return res.kinds ?? [];
}

async function setPlatformPolicy(request: Record<string, unknown>): Promise<any> {
  return svc.setPlatformPolicy(request, {});
}

async function listUpstreams(): Promise<any[]> {
  const res = await svc.listUpstreams({}, {});
  return res.upstreams ?? [];
}

async function listPublishedModels(): Promise<any[]> {
  const res = await svc.listPublishedModels({}, {});
  return res.models ?? [];
}

/* ------------------------------------------------------------------ *
 * 库里的行数（不写死个数：一律跟表比）
 * ------------------------------------------------------------------ */

function countPlatforms(): number {
  return Number((store().prepare("SELECT COUNT(*) AS n FROM platform").get() as any)?.n ?? 0);
}

function countProviders(): number {
  return Number((store().prepare("SELECT COUNT(*) AS n FROM provider").get() as any)?.n ?? 0);
}

function providersOf(platform: string): number {
  return Number(
    (store().prepare("SELECT COUNT(*) AS n FROM provider WHERE platform = ?").get(platform) as any)?.n ?? 0,
  );
}

/** 这个账号名下的凭据有几条（secrets 表的 id 前缀就是账号 id）。 */
function secretsOf(accountId: string): number {
  const rows = store().prepare("SELECT id FROM secrets").all() as any[];
  return rows.filter((row) => {
    const id = String(row.id);
    return id.startsWith(`key:provider:${accountId}`) || id.startsWith(`session:provider:${accountId}`);
  }).length;
}

/* ------------------------------------------------------------------ *
 * 假的上游：只答 /models
 * ------------------------------------------------------------------ */

let modelsStatus = 200;
let modelsPayload: unknown = { data: [{ id: "fake-1" }] };

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(modelsStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(modelsPayload));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;

/* ------------------------------------------------------------------ *
 * 1. 加平台
 * ------------------------------------------------------------------ */

section("加平台");

const platformsBefore = countPlatforms();
const added = await guard(() =>
  addPlatform({
    id: "acme",
    label: "Acme",
    baseUrl: "https://api.acme.test/v1",
  }),
);
check("开放平台加得进去", added !== null, `${errCode()} ${errDetail()}`);
// 不带 kind = 通用那一类（OpenAI 兼容）：老面板不送这一格。
check("不带 kind 时建出来是 openai", added?.platform?.kind === "openai", show(added?.platform?.kind));
check("库里的平台多了一行", countPlatforms() === platformsBefore + 1, `${countPlatforms()} vs ${platformsBefore}`);
check("答复里带着这个平台", added?.platform?.id === "acme", show(added?.platform));
// 成功答复里没有 ok / message 两格了（失败是一次 Connect 错误）。
check(
  "成功答复里没有 ok 与 message",
  added !== null && !("ok" in added) && !("message" in added),
  show(added),
);

const upstreams = await listUpstreams();
const acme = upstreams.find((u) => u.id === "acme");
check("ListUpstreams 里有它", Boolean(acme), show(upstreams.map((u) => u.id)));
check("它是一个开放平台", acme?.isOpenPlatform === true, show(acme?.isOpenPlatform));
// 自建平台是表里的一行：面板要能改它、删它。
check("自建平台的 from_row 是 true", acme?.fromRow === true, show(acme?.fromRow));
check("ListUpstreams 里的 kind 是 openai", acme?.kind === "openai", show(acme?.kind));
check("没有账号时状态是没有凭据", acme?.state === UpstreamState.NO_CREDENTIAL, String(acme?.state));
check("额度插件那一格是空的", acme?.quotaPlugin === "", show(acme?.quotaPlugin));
// 模型目录两格：报的是平台行里的那份（刚建的平台还没有目录）。
const acmeRow = openPlatformOf("acme");
check("新加的平台目录是空的", (acme?.models ?? []).length === 0, show(acme?.models));
check("新加的平台没拉过目录", acme?.modelsFetchedAtMs === 0n, show(acme?.modelsFetchedAtMs));
check(
  "报出来的清单跟库里那一行一样",
  (acme?.models ?? []).join(",") === (acmeRow?.models.items ?? []).join(","),
  show([acme?.models, acmeRow?.models.items]),
);

/* ------------------------------------------------------------------ *
 * 2. 加平台：四种拒绝
 * ------------------------------------------------------------------ */

section("加平台：拒绝");

const badId = await guard(() =>
  addPlatform({
    id: "Acme_Bad",
    label: "不合法",
    baseUrl: "https://api.acme.test/v1",
  }),
);
check("id 不合法被拒", badId === null, show(badId));
check("机器码说的是 id 不合法", errCode() === errorCodes.PLATFORM_ID_INVALID, `${errCode()} / ${errDetail()}`);
check("状态码是 InvalidArgument", errStatus() === 3, String(errStatus()));
check("细节里只有事实（id 与规矩），没有中文文案", /[\u4e00-\u9fa5]/.test(errDetail()) === false, errDetail());

const builtInClash = await guard(() =>
  addPlatform({
    id: SIMULATED_CLIENTS[0].id,
    label: "撞内置平台",
    baseUrl: "https://api.acme.test/v1",
  }),
);
check("跟已有的内置平台重名被拒", builtInClash === null, show(builtInClash));
check("机器码说的是平台已存在", errCode() === errorCodes.PLATFORM_ALREADY_EXISTS, `${errCode()} / ${errDetail()}`);
check("状态码是 AlreadyExists", errStatus() === 6, String(errStatus()));

// 账号 id 与平台 id 相互独立：账号 id 是自增数，平台表看不见它，也不占平台表
// 的位置。
const qoderFirst = addAccount({ platform: "qoder" });
const qoderSecond = addAccount({ platform: "qoder" });
check(
  "同一平台的两个账号 id 不同，都是自增数",
  Boolean(qoderFirst.id && qoderSecond.id) &&
    qoderFirst.id !== qoderSecond.id &&
    /^\d+$/.test(qoderFirst.id!) &&
    /^\d+$/.test(qoderSecond.id!),
  show([qoderFirst.id, qoderSecond.id]),
);
check(
  "账号 id 里没有平台的名字",
  [qoderFirst.id!, qoderSecond.id!].every((id) => !id.includes("qoder")),
  show([qoderFirst.id, qoderSecond.id]),
);

const again = await guard(() =>
  addPlatform({
    id: "acme",
    label: "又一个",
    baseUrl: "https://api.acme.test/v1",
  }),
);
check("重复建被拒", again === null, show(again));
check("机器码说的是平台已存在", errCode() === errorCodes.PLATFORM_ALREADY_EXISTS, `${errCode()} / ${errDetail()}`);
check(
  "被拒的那些都没写进表",
  countPlatforms() === platformsBefore + 1,
  `${countPlatforms()} vs ${platformsBefore + 1}`,
);

// 撞车给的是同一个机器码。事务外那句判重只看得见本进程：两个进程同时建同一个
// id 时后一个撞在 INSERT 的唯一约束上，SQLite 的原话（UNIQUE constraint failed:
// platform.id）只进细节，面板照码显示自己的话。
const clashAgain = await guard(() =>
  addPlatform({
    id: "acme",
    label: "撞车",
    baseUrl: "https://api.acme.test/v1",
  }),
);
check("撞车被拒", clashAgain === null, show(clashAgain));
check("撞车的机器码也是平台已存在", errCode() === errorCodes.PLATFORM_ALREADY_EXISTS, `${errCode()} / ${errDetail()}`);
check(
  "撞车没多写一行",
  countPlatforms() === platformsBefore + 1,
  `${countPlatforms()} vs ${platformsBefore + 1}`,
);

/* ------------------------------------------------------------------ *
 * 3. 改平台
 * ------------------------------------------------------------------ */

section("改平台");

const renamed = await guard(() => updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
}));
check("改名改得掉", renamed !== null, errDetail());
check("名字改了", openPlatformOf("acme")?.label === "Acme Cloud", String(openPlatformOf("acme")?.label));

const emptyBase = await guard(() => updatePlatform({ id: "acme", label: "Acme Cloud", baseUrl: "" }));
check("地址空串被拒", emptyBase === null, show(emptyBase));
check(
  "机器码说的是地址没给",
  errCode() === errorCodes.PLATFORM_BASE_URL_MISSING,
  `${errCode()} / ${errDetail()}`,
);
check(
  "库里的地址没变",
  openPlatformOf("acme")?.baseUrl === "https://api.acme.test/v1",
  String(openPlatformOf("acme")?.baseUrl),
);
check("库里的名字没变", openPlatformOf("acme")?.label === "Acme Cloud", String(openPlatformOf("acme")?.label));

const withPlugin = await guard(() => updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "qiniu",
}));
check("额度插件写得进去", withPlugin !== null, errDetail());
check("插件写进库里了", openPlatformOf("acme")?.quotaPlugin === "qiniu", String(openPlatformOf("acme")?.quotaPlugin));
const withPluginListed = (await listUpstreams()).find((u) => u.id === "acme");
check(
  "ListUpstreams 报的是那个插件",
  withPluginListed?.quotaPlugin === "qiniu",
  show(withPluginListed?.quotaPlugin),
);

// 没登记的插件 id：拒绝保存。收下去之后这个平台一条额度结论都不会有，而面板上
// 看着「已选插件」—— 静默不工作比拒绝保存更难查。
const badPlugin = await guard(() => updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "qiniu-portal",
}));
check("没登记的插件 id 被拒", badPlugin === null, show(badPlugin));
check(
  "机器码说的是没有这个额度插件",
  errCode() === errorCodes.QUOTA_PLUGIN_UNKNOWN,
  `${errCode()} / ${errDetail()}`,
);
check("细节里带着那个 id 与登记过的几个", errDetail().includes("qiniu-portal") && errDetail().includes("qiniu"), errDetail());
// 被拒的那次什么都没写：库里、ListUpstreams 都是原来那个。
check("被拒时没有答复", badPlugin === null, show(badPlugin));
const afterBadPlugin = (await listUpstreams()).find((u) => u.id === "acme");
check(
  "库里那一格没被改",
  openPlatformOf("acme")?.quotaPlugin === "qiniu",
  String(openPlatformOf("acme")?.quotaPlugin),
);
check(
  "ListUpstreams 报的还是原来那个",
  afterBadPlugin?.quotaPlugin === "qiniu",
  show(afterBadPlugin?.quotaPlugin),
);
check(
  "名字与地址也没被顺手改掉",
  openPlatformOf("acme")?.label === "Acme Cloud" && openPlatformOf("acme")?.baseUrl === "https://api.acme.test/v1",
  show([openPlatformOf("acme")?.label, openPlatformOf("acme")?.baseUrl]),
);

// 空串 = 不选插件，那是合法的：清得掉。
const clearedPlugin = await guard(() => updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "",
}));
check("空串 = 不选插件，收得下", clearedPlugin !== null, errDetail());
check("插件那一格清掉了", openPlatformOf("acme")?.quotaPlugin === "", String(openPlatformOf("acme")?.quotaPlugin));
check(
  "ListUpstreams 报的是空串",
  (await listUpstreams()).find((u) => u.id === "acme")?.quotaPlugin === "",
  show((await listUpstreams()).find((u) => u.id === "acme")?.quotaPlugin),
);
// 清完再选回来：下面的手工目录那一节要用带插件的平台。
const restoredPlugin = await guard(() => updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "qiniu",
}));
check("登记的插件选得回来", restoredPlugin !== null, errDetail());

// AddPlatform 接 quota_plugin 了（契约里 AddPlatformRequest 有这一格，带
// presence）：没给 = 这一类声明的默认插件；给了空串 = 不用插件；给了 id = 用
// 那个（必须已登记，没登记就拒，一个字都不落库）。
// 「不带 = 用这一类声明的默认插件」这一条现在没有可建的 kind 能演示：剩下的两种
// 方言都没有默认插件（默认插件属于厂商那五家，它们已经不能建了）。所以这里只留
// 「空串 = 不用插件」那半边，另一半靠厂商 kind 被拒来证明。
const pluginEmpty = await guard(() => addPlatform({
  id: "acme-plugin-empty",
  label: "不用插件的加平台",
  baseUrl: "https://api.acme.test/v1",
  kind: "openai",
  quotaPlugin: "",
}));
check("加平台：quota_plugin 给空串建得起来", pluginEmpty !== null, errDetail());
check(
  "空串是「不用插件」，不是默认那个",
  openPlatformOf("acme-plugin-empty")?.quotaPlugin === "",
  String(openPlatformOf("acme-plugin-empty")?.quotaPlugin),
);

const pluginUnknown = await guard(() => addPlatform({
  id: "acme-plugin-unknown",
  label: "没登记的插件",
  baseUrl: "https://api.acme.test/v1",
  kind: "openai",
  quotaPlugin: "no-such-plugin",
}));
check("加平台：没登记的插件被拒", pluginUnknown === null, show(pluginUnknown));
check(
  "机器码是 QUOTA_PLUGIN_UNKNOWN",
  errCode() === errorCodes.QUOTA_PLUGIN_UNKNOWN,
  `${errCode()} / ${errDetail()}`,
);
check(
  "被拒的那一行没写进表",
  openPlatformOf("acme-plugin-unknown") === null,
  show(openPlatformOf("acme-plugin-unknown")),
);

// 这两个平台只是为了上面那几行断言：删掉，免得影响后面按行数比的那几节。
for (const id of ["acme-plugin-empty"]) {
  const dropped = await guard(() => deletePlatform({ id }));
  check(`为了那条断言建的平台删得掉：${id}`, dropped !== null, errDetail());
}

const manual = await guard(() => updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "qiniu",
}));
check("改平台走得通", manual !== null, errDetail());
const manualRow = openPlatformOf("acme");
check(
  "目录没被写进去（目录只有上游那一份）",
  (manualRow?.models.items ?? []).length === 0,
  show(manualRow?.models),
);
const manualListed = (await listUpstreams()).find((u) => u.id === "acme");
check("ListUpstreams 报的是空清单", (manualListed?.models ?? []).length === 0, show(manualListed?.models));
check(
  "ListUpstreams 报的是没拉过目录",
  manualListed?.modelsFetchedAtMs === 0n,
  show(manualListed?.modelsFetchedAtMs),
);

/* ------------------------------------------------------------------ *
 * 3b. 没给的格不动：base_url / quota_plugin 带 presence
 * ------------------------------------------------------------------ */

section("没给的格不动");

// 面板对模拟客户端那一族故意不发这两格（地址由预置定死）。没有 presence 时
// 「没给」与「给空串」是同一份字节，改一次名字就把库里的额度插件抹掉。
const presenced = await guard(() => addPlatform({
  id: "presence-demo",
  label: "Presence Demo",
  baseUrl: "https://api.presence.test/v1",
}));
check("平台建得起来", presenced !== null, errDetail());
// 模拟客户端那一行的额度插件先改成 qiniu：改名字之后必须还在。
const pluginOnSimulated = await guard(() => updatePlatform({ id: "minimax", quotaPlugin: "qiniu" }));
check("模拟客户端那一行也写得进插件", pluginOnSimulated !== null, show(pluginOnSimulated));
check(
  "库里那一格是 qiniu",
  openPlatformOf("minimax")?.quotaPlugin === "qiniu",
  String(openPlatformOf("minimax")?.quotaPlugin),
);

// 只送名字（面板对模拟客户端就是这样）：两格都不发。
const renameOnly = await guard(() => updatePlatform({ id: "minimax", label: "只改个名" }));
check("只送名字：ok", renameOnly !== null, show(renameOnly));
const renamedSimulatedRow = openPlatformOf("minimax");
check("名字改了", renamedSimulatedRow?.label === "只改个名", String(renamedSimulatedRow?.label));
check(
  "没给的额度插件没被抹掉",
  renamedSimulatedRow?.quotaPlugin === "qiniu",
  String(renamedSimulatedRow?.quotaPlugin),
);
check("没给的地址没被改", renamedSimulatedRow?.baseUrl === "", show(renamedSimulatedRow?.baseUrl));

// 开放平台也一样：只送名字，地址与额度插件都留着。
const labelOnly = await guard(() => updatePlatform({ id: "presence-demo", label: "Presence Demo 改" }));
check("开放平台只送名字：ok", labelOnly !== null, show(labelOnly));
check(
  "名字改了",
  openPlatformOf("presence-demo")?.label === "Presence Demo 改",
  String(openPlatformOf("presence-demo")?.label),
);
check(
  "没给的地址没被清掉",
  openPlatformOf("presence-demo")?.baseUrl === "https://api.presence.test/v1",
  String(openPlatformOf("presence-demo")?.baseUrl),
);

// 只改额度插件：地址与名字都不动。
const pluginOnly = await guard(() => updatePlatform({ id: "presence-demo", quotaPlugin: "sensenova-pools" }));
check("只送插件：ok", pluginOnly !== null, show(pluginOnly));
const pluginOnlyRow = openPlatformOf("presence-demo");
check("插件写进去了", pluginOnlyRow?.quotaPlugin === "sensenova-pools", String(pluginOnlyRow?.quotaPlugin));
check(
  "名字与地址没被顺手改掉",
  pluginOnlyRow?.label === "Presence Demo 改" && pluginOnlyRow?.baseUrl === "https://api.presence.test/v1",
  show([pluginOnlyRow?.label, pluginOnlyRow?.baseUrl]),
);
// 名字没给是「别动它」，显式空串还是错（平台得有名字）：两件事不能糊成一件。
const emptyLabel = await guard(() => updatePlatform({ id: "presence-demo", label: "" }));
check(
  "名字显式空串还是被拒",
  emptyLabel === null && errCode() === errorCodes.PLATFORM_LABEL_MISSING,
  `${errCode()} / ${show(emptyLabel)}`,
);
check(
  "被拒时名字还在",
  openPlatformOf("presence-demo")?.label === "Presence Demo 改",
  String(openPlatformOf("presence-demo")?.label),
);

// 显式空串 = 清空。地址空串还是被地址校验拦下（平台得有地址），所以拆开断言：
// 先看拦不拦，再看插件那一格清得掉。
const explicitEmpty = await guard(() => updatePlatform({
  id: "presence-demo",
  label: "Presence Demo 改",
  baseUrl: "",
  quotaPlugin: "",
}));
check("地址显式空串被拒", explicitEmpty === null, show(explicitEmpty));
check("被拒时库里的地址没变", openPlatformOf("presence-demo")?.baseUrl === "https://api.presence.test/v1", String(openPlatformOf("presence-demo")?.baseUrl));
check("被拒时库里的插件也没变", openPlatformOf("presence-demo")?.quotaPlugin === "sensenova-pools", String(openPlatformOf("presence-demo")?.quotaPlugin));
const clearPlugin = await guard(() => updatePlatform({ id: "presence-demo", quotaPlugin: "" }));
check("插件显式空串收得下", clearPlugin !== null, show(clearPlugin));
check("插件那一格清掉了", openPlatformOf("presence-demo")?.quotaPlugin === "", String(openPlatformOf("presence-demo")?.quotaPlugin));
check(
  "清插件没顺手把地址清掉",
  openPlatformOf("presence-demo")?.baseUrl === "https://api.presence.test/v1",
  String(openPlatformOf("presence-demo")?.baseUrl),
);

// 收尾：删掉这个平台、把模拟客户端那一行还原（后面几节拿它当模板平台的对照）。
const droppedPresence = await guard(() => deletePlatform({ id: "presence-demo" }));
check("为这一节建的平台删得掉", droppedPresence !== null, errDetail());
const restoredSimulated = await guard(() => updatePlatform({
  id: "minimax",
  label: SIMULATED_CLIENTS[0].label,
  quotaPlugin: "",
}));
check("模拟客户端那一行还原得掉", restoredSimulated !== null, show(restoredSimulated));
check(
  "还原之后插件是空串",
  openPlatformOf("minimax")?.quotaPlugin === "",
  String(openPlatformOf("minimax")?.quotaPlugin),
);

/* ------------------------------------------------------------------ *
 * 4. 删平台
 * ------------------------------------------------------------------ */

section("删平台");

// 名下放一个账号与一把凭据：删平台要把它们一起删干净。
const account = addAccount({ platform: "acme" });
const accountId = account.id ?? "";
check("账号加得起来", account.ok === true && accountId !== "", account.message);
// 这个平台选了额度插件（上面那一节写的），所以凭据是两段：数组短了服务端整单
// 不改（那是「调用方不知道这个插件要几段」）。第二段留空：门户 cookie 本来就没有。
const keyed = setProviderKeys(accountId, ["sk-acme-secret", ""]);
check("凭据写进去了", keyed.ok === true && keyed.count === 1, keyed.message);
check("secrets 表里有那一行", secretsOf(accountId) === 1, String(secretsOf(accountId)));

// 一个指向它的已发布模型。
saveAggregateModel({
  id: "acme-model",
  displayName: "Acme Model",
  strategy: "single",
  targets: [{ group: "acme" as any, upstreamModel: "m-1", weight: 1, position: 0, enabled: true }],
});
reloadAggregate();

const providersBefore = countProviders();
const deleted = await guard(() => deletePlatform({ id: "acme" }));
check("平台删得掉", deleted !== null, errDetail());
// 成功答复里没有 message 了：连带删了什么写进日志（下面这一条钉答复的形状）。
check(
  "删成功的答复是空的（没有 ok 与 message）",
  deleted !== null && !("ok" in deleted) && !("message" in deleted),
  show(deleted),
);
check("库里的平台行没了", countPlatforms() === platformsBefore, `${countPlatforms()} vs ${platformsBefore}`);
check("账号没了", countProviders() === providersBefore - 1, `${countProviders()} vs ${providersBefore - 1}`);
check("那个平台名下没有账号了", providersOf("acme") === 0, String(providersOf("acme")));
check("凭据没了", secretsOf(accountId) === 0, String(secretsOf(accountId)));
const afterDelete = await listUpstreams();
check(
  "ListUpstreams 里不再出现",
  !afterDelete.some((u) => u.id === "acme"),
  show(afterDelete.map((u) => u.id)),
);

// 指向它的已发布模型：目标留着，面板上它显示「平台已停用」——
// 这与平台停用、账号被删时的做法一样（lib/admin/models.ts 的 targetBlocker）。
const models = await listPublishedModels();
const acmeModel = models.find((m) => m.id === "acme-model");
check("那个模型还在", Boolean(acmeModel), show(models.map((m) => m.id)));
check("它现在接不了", acmeModel?.published === false, show(acmeModel?.published));
check(
  "说的是平台已停用",
  acmeModel?.unpublishedReason === UnpublishedReason.UPSTREAM_DISABLED,
  String(acmeModel?.unpublishedReason),
);
// 指向它的那几个模型，现在是日志里的事（答复里没有 message 了）。
check(
  "删的时候把指向它的模型写进了日志",
  routerLog().includes("1 个已发布模型指向它"),
  routerLog().slice(-200),
);

// zcode 也在目录里，且不再收起来：目录条目在、表里也有行、面板上看得见。
//
// 目录里那一条必须留着：它是 zcode 这个 kind 的预置来源，删了平台就无从播种。
check(
  "目录里有 zcode 那一条，且不再是 hidden",
  SIMULATED_CLIENTS.some((c) => c.id === "zcode" && c.hidden === false),
  show(SIMULATED_CLIENTS.filter((c) => c.id === "zcode")),
);
check(
  "zcode 在平台列表里",
  (await listUpstreams()).some((u: any) => u.id === "zcode"),
  show((await listUpstreams()).map((u: any) => u.id)),
);

// 播种的行删得掉，而且删掉之后不会在下次启动长回来（墓碑里记着）。挑一条后面几
// 节用不到的：workbuddy-global（minimax 后面还要当对照）。
const builtInDelete = await guard(() => deletePlatform({ id: "workbuddy-global" }));
check("播种的模拟客户端平台删得掉", builtInDelete !== null, show(builtInDelete));
check(
  "删了就不在列表里了",
  !(await listUpstreams()).some((u: any) => u.id === "workbuddy-global"),
  show((await listUpstreams()).map((u: any) => u.id)),
);
check(
  "删预置的行留了墓碑",
  platformPresetRemoved("workbuddy-global") === true,
  show(platformPresetRemoved("workbuddy-global")),
);
migrateSimulatedClients(store());
check(
  "删掉之后播种不补回来",
  openPlatformOf("workbuddy-global") === null,
  show(openPlatformOf("workbuddy-global")),
);
check(
  "不补回来也不会又冒出一个空平台",
  !(await listUpstreams()).some((u: any) => u.id === "workbuddy-global"),
  show((await listUpstreams()).map((u: any) => u.id)),
);
// 把墓碑清掉就回到「没删过」：后面几节按行数比，得补回基线。
forgetPlatformPresetRemoved("workbuddy-global");
migrateSimulatedClients(store());
check(
  "墓碑清掉之后播种补回来了",
  openPlatformOf("workbuddy-global")?.kind === "workbuddy",
  show(openPlatformOf("workbuddy-global")),
);

const missingDelete = await guard(() => deletePlatform({ id: "no-such-platform" }));
check("删不存在的平台会说不存在", missingDelete === null, show(missingDelete));
check(
  "机器码说的是没有这个平台",
  errCode() === errorCodes.PLATFORM_NOT_FOUND,
  `${errCode()} / ${errDetail()}`,
);
check("状态码是 NotFound", errStatus() === 5, String(errStatus()));

/* ------------------------------------------------------------------ *
 * 4b. 建平台时选类型
 * ------------------------------------------------------------------ */

section("建平台的类型");

// 带 kind：面板上选的那一类写进库里，ListUpstreams 报的也是它。
const typed = await guard(() => addPlatform({
  id: "kind-demo",
  label: "Kind Demo",
  baseUrl: "https://api.kind.test/v1",
  kind: "anthropic",
}));
check("带 kind 的平台建得起来", typed !== null, errDetail());
check("答复里报的是那一类", typed?.platform?.kind === "anthropic", show(typed?.platform?.kind));
check("库里那一行是那一类", openPlatformOf("kind-demo")?.kind === "anthropic", String(openPlatformOf("kind-demo")?.kind));
const kindListed = (await listUpstreams()).find((u) => u.id === "kind-demo");
check("ListUpstreams 里这个平台的 kind 是 anthropic", kindListed?.kind === "anthropic", show(kindListed?.kind));

// 模板平台照实报它自己那一类（不是清一色的 openai）。
const templateKinds = (await listUpstreams()).filter((u) => !u.isOpenPlatform);
check(
  "模板平台报的是它们自己那一类",
  templateKinds.length > 0 && templateKinds.every((u) => u.kind !== ""),
  show(templateKinds.map((u) => [u.id, u.kind])),
);

// 没登记的 kind：拒，并把能建的列出来（用 label）。
const badKind = await guard(() => addPlatform({
  id: "kind-bad",
  label: "Kind Bad",
  baseUrl: "https://api.kind.test/v1",
  kind: "no-such-kind",
}));
check("没登记的 kind 被拒", badKind === null, show(badKind));
check(
  "机器码说的是没有这一类",
  errCode() === errorCodes.PLATFORM_KIND_UNKNOWN,
  `${errCode()} / ${errDetail()}`,
);
check(
  "细节里带着那个 kind 与能建的那几类",
  errDetail().includes("no-such-kind") &&
    errDetail().includes("openai") &&
    errDetail().includes("anthropic") &&
    // 厂商那五家已经不是能建的一类：候选里不该再出现它们。
    !["qiniu", "xinghuo", "sensenova", "intern-ai", "tokenrhythm"].some((kind) =>
      errDetail().includes(kind),
    ),
  errDetail(),
);
check("被拒的那一行没写进表", openPlatformOf("kind-bad") === null, show(openPlatformOf("kind-bad")));
// 这种「目录里根本没有这一类」的也不许指向预置列表：能建的那两种方言已经列出来了。
check("没登记的 kind 不让人去选预置", !errDetail().includes("preset"), errDetail());

// 厂商那五家不再能建：走 AddPlatform 会撞在能建的白名单上，一个字节也不落库。
for (const kind of ["qiniu", "xinghuo", "sensenova", "intern-ai", "tokenrhythm"]) {
  const refused = await guard(() => addPlatform({
    id: `kind-build-${kind}`,
    label: `Kind Build ${kind}`,
    baseUrl: "https://api.kind.test/v1",
    kind,
  }));
  check(`厂商类型不再能建：${kind}`, refused === null, show(refused));
  check(
    `${kind} 的机器码是「没有这一类」`,
    errCode() === errorCodes.PLATFORM_KIND_UNKNOWN,
    `${errCode()} / ${errDetail()}`,
  );
  check(`${kind} 没有写进表`, openPlatformOf(`kind-build-${kind}`) === null, show(openPlatformOf(`kind-build-${kind}`)));
}

// 建好之后换不了类型。
//
// 线上换不了：UpdatePlatformRequest 里没有 kind 这一格（只有 AddPlatformRequest
// 有），面板送不上来。这里走数据层那一层：内部调用方（迁移、脚本）想改类型的
// 时候，得有个说得清楚的拒绝，而不是默默写成别的。
const kindSwitch = updateOpenPlatform("kind-demo", { kind: "openai", label: "Kind Demo 改名" });
check(
  "换类型被拒，机器码说的是类型定死了",
  kindSwitch.ok === false && kindSwitch.code === errorCodes.PLATFORM_KIND_FIXED,
  show(kindSwitch),
);
check("库里 kind 不变", openPlatformOf("kind-demo")?.kind === "anthropic", String(openPlatformOf("kind-demo")?.kind));
check(
  "被拒的那一次别的字段也没动",
  openPlatformOf("kind-demo")?.label === "Kind Demo",
  String(openPlatformOf("kind-demo")?.label),
);
// 同一类当没传：别的字段照常改（否则「同 kind 当没传」就是整个更新都拒了）。
const sameKind = updateOpenPlatform("kind-demo", { kind: "anthropic", label: "Kind Demo 改名" });
check("同 kind 放行", sameKind.ok === true, sameKind.message);
check("名字改了", openPlatformOf("kind-demo")?.label === "Kind Demo 改名", String(openPlatformOf("kind-demo")?.label));
check("kind 还是原来那个", openPlatformOf("kind-demo")?.kind === "anthropic", String(openPlatformOf("kind-demo")?.kind));

// 收尾：上面建的这一个删掉，后面按行数比的小节不受影响。
const droppedTyped = await guard(() => deletePlatform({ id: "kind-demo" }));
check("带类型的平台删得掉", droppedTyped !== null, errDetail());
check("表里回到基线", countPlatforms() === platformsBefore, `${countPlatforms()} vs ${platformsBefore}`);

/* ------------------------------------------------------------------ *
 * 4c. 能建的平台种类
 * ------------------------------------------------------------------ */

section("能建的平台种类");

const kindOptions = await listPlatformKinds();
const choices = platformKindChoices();
const dialectKinds = kindOptions.filter((k: any) => k.category === "dialect");
const simulatedKinds = kindOptions.filter((k: any) => k.category === "simulated");

// 两族：先是方言（用户自己加，选的是报文格式），再是预置的模拟客户端（从目录里
// 挑一个）。
check("方言那一族在答复里", dialectKinds.length === PLATFORM_KIND_OPTIONS.length, show(dialectKinds.map((k: any) => k.kind)));
check(
  "模拟客户端那一族也在答复里",
  simulatedKinds.length === SIMULATED_CLIENTS.filter((c) => !c.hidden).length,
  show(simulatedKinds.map((k: any) => k.presetId)),
);
check(
  "顺序：先方言后模拟客户端",
  kindOptions.map((k: any) => k.kind).join(",") === choices.map((o) => o.kind).join(",") &&
    kindOptions.slice(0, dialectKinds.length).every((k: any) => k.category === "dialect"),
  show([kindOptions.map((k: any) => `${k.category}:${k.kind}`), choices.map((o) => `${o.category}:${o.kind}`)]),
);
check(
  "每一对都是那两种之一",
  kindOptions.every((k: any) => k.category === "dialect" || k.category === "simulated"),
  show(kindOptions.map((k: any) => k.category)),
);
check(
  "每一条都带名字、默认地址、category、preset_id、region 这五格",
  kindOptions.every(
    (k: any) =>
      typeof k.kind === "string" &&
      typeof k.label === "string" &&
      typeof k.defaultBaseUrl === "string" &&
      typeof k.category === "string" &&
      typeof k.presetId === "string" &&
      typeof k.region === "string",
  ),
  show(kindOptions),
);
check(
  "label 一个都不是空的",
  kindOptions.every((k: any) => String(k.label ?? "").length > 0),
  show(kindOptions.map((k: any) => k.label)),
);

// 方言那两条：与原来一样（id 由用户填，所以要占位地址，且能自己拉目录）。
const pureDialects = dialectKinds.filter((k: any) => k.kind === "openai" || k.kind === "anthropic");
check(
  "方言那两条就是 openai 与 anthropic",
  pureDialects.map((k: any) => k.kind).join(",") === "openai,anthropic",
  show(pureDialects.map((k: any) => k.kind)),
);
check(
  "方言类的 preset_id 与 region 都是空串（id 由用户填）",
  pureDialects.every((k: any) => k.presetId === "" && k.region === ""),
  show(pureDialects.map((k: any) => [k.presetId, k.region])),
);
const openaiOption = dialectKinds.find((k: any) => k.kind === "openai");
check("openai 的默认地址是空串", openaiOption?.defaultBaseUrl === "", show(openaiOption?.defaultBaseUrl));
check("openai 是方言族（目录从上游拉）", openaiOption?.category === "dialect", show(openaiOption?.category));
const anthropicOption = dialectKinds.find((k: any) => k.kind === "anthropic");
check("anthropic 的默认地址是空串", anthropicOption?.defaultBaseUrl === "", show(anthropicOption?.defaultBaseUrl));
check(
  "anthropic 是方言族（目录从上游拉）",
  anthropicOption?.category === "dialect",
  show(anthropicOption?.category),
);

// 模拟客户端那几条：kind / preset_id / region 跟目录一致，地址不由用户填。
const visibleSimulated = SIMULATED_CLIENTS.filter((c) => !c.hidden);
check(
  "模拟客户端那几条的 preset_id 与目录一致（含顺序）",
  simulatedKinds.map((k: any) => k.presetId).join(",") === visibleSimulated.map((c) => c.id).join(","),
  show([simulatedKinds.map((k: any) => k.presetId), visibleSimulated.map((c) => c.id)]),
);
check(
  "每一条的 kind、名字、区域都照目录",
  simulatedKinds.every((k: any) => {
    const preset = visibleSimulated.find((c) => c.id === k.presetId);
    return preset !== undefined && preset.kind === k.kind && preset.label === k.label && preset.region === k.region;
  }),
  show(simulatedKinds.map((k: any) => [k.presetId, k.kind, k.label, k.region])),
);
check(
  "模拟客户端没有默认地址、目录由代码给出",
  simulatedKinds.every((k: any) => k.defaultBaseUrl === "" && k.category === "simulated"),
  show(simulatedKinds.map((k: any) => [k.defaultBaseUrl, k.category])),
);
check(
  "zcode 在答复里",
  kindOptions.some((k: any) => k.kind === "zcode" || k.presetId === "zcode"),
  show(kindOptions.map((k: any) => k.presetId)),
);
// 厂商那五家不在下拉里，也从登记表里退场了：迁移后的行上是 kind=openai，
// 登记表里没有它们 —— 默认地址改由迁移写进行里（lib/store.ts 的
// LEGACY_VENDOR_KINDS，地址表另有一份在 lib/quota-plugin-registry.ts 的
// VENDOR_INFERENCE_BASES，给额度端点用）。
const VENDOR_KINDS = ["qiniu", "xinghuo", "sensenova", "intern-ai", "tokenrhythm"];
check(
  "厂商类型不在下拉里",
  VENDOR_KINDS.every((kind) => !kindOptions.some((k: any) => k.kind === kind)),
  show(kindOptions.map((k: any) => k.kind)),
);
check(
  "厂商 kind 不在登记表里（退场了）",
  VENDOR_KINDS.every((kind) => kindOf(kind) === null),
  VENDOR_KINDS.map((kind) => `${kind}:${String(kindOf(kind)?.kind ?? "无")}`).join(","),
);

/* ------------------------------------------------------------------ *
 * 4d. 建预置的模拟客户端
 * ------------------------------------------------------------------ */

section("建预置的模拟客户端");

// 播种进来的 minimax 先删掉（后面几节把它当模板平台的对照）：这一节要查的是
// 从面板建一条回来 —— 删过的那条留着墓碑，建回来得把墓碑清掉。
const platformsBeforeSimulated = countPlatforms();
const removedMinimax = await guard(() => deletePlatform({ id: "minimax" }));
check("先删掉播种进来的那一条", removedMinimax !== null, show(removedMinimax));
// 删了就不在列表里：那一行没了，from_row 与整个平台一起消失（不是变成 false 的
// 一条残骸）。重启后仍不出现由墓碑那一段断言（workbuddy-global）。
check(
  "删掉之后列表里没有它",
  !(await listUpstreams()).some((u) => u.id === "minimax"),
  show((await listUpstreams()).map((u) => u.id)),
);

const builtMinimax = await guard(() => addPlatform({ kind: "minimax", id: "minimax", label: "MiniMax Code" }));
check("预置的模拟客户端建得起来", builtMinimax !== null, show(builtMinimax));
check("答复里带着这一行", builtMinimax?.platform?.id === "minimax", show(builtMinimax?.platform));
check("区域照预置", openPlatformOf("minimax")?.region === "cn", show(openPlatformOf("minimax")?.region));
check(
  "行上不预填目录（那一族的目录由代码给出）",
  (openPlatformOf("minimax")?.models.items ?? []).length === 0,
  show(openPlatformOf("minimax")?.models),
);
check("地址是空串", openPlatformOf("minimax")?.baseUrl === "", show(openPlatformOf("minimax")?.baseUrl));
check("额度插件是空串", openPlatformOf("minimax")?.quotaPlugin === "", show(openPlatformOf("minimax")?.quotaPlugin));
check("墓碑清掉了", platformPresetRemoved("minimax") === false, show(platformPresetRemoved("minimax")));
check(
  "表里的行数回到删之前",
  countPlatforms() === platformsBeforeSimulated,
  `${countPlatforms()} vs ${platformsBeforeSimulated}`,
);

// id 由预置定死：它是请求路径里那一段，也是调用方 base_url 的那一段。
const wrongSimulatedId = await guard(() => addPlatform({ kind: "minimax", id: "my-minimax", label: "我的 MiniMax" }));
check("模拟客户端的 id 不能自己取", wrongSimulatedId === null, show(wrongSimulatedId));
check(
  "机器码说的是 id 不是预置那一个，细节里带着预置的那几个",
  errCode() === errorCodes.PLATFORM_ID_NOT_PRESET &&
    errDetail().includes("my-minimax") &&
    errDetail().includes("minimax"),
  `${errCode()} / ${errDetail()}`,
);
check("被拒的那一行没写进库", openPlatformOf("my-minimax") === null, show(openPlatformOf("my-minimax")));
check(
  "拒绝时一行都没多",
  countPlatforms() === platformsBeforeSimulated,
  `${countPlatforms()} vs ${platformsBeforeSimulated}`,
);

// zcode 现在是真平台（目录里一条、表里一行）：再建同 id 就是撞车。
const zcodeBuild = await guard(() => addPlatform({ kind: "zcode", id: "zcode", label: "ZCode" }));
check("zcode 那一行建不了第二次", zcodeBuild === null, show(zcodeBuild));
const zcodeMessage = errDetail();
check(
  "机器码说的是平台已存在",
  errCode() === errorCodes.PLATFORM_ALREADY_EXISTS,
  `${errCode()} / ${zcodeMessage}`,
);
check("状态码是 AlreadyExists", errStatus() === 6, String(errStatus()));
check(
  "库里仍然只有一行 zcode",
  openPlatformOf("zcode") !== null && countPlatforms() === platformsBeforeSimulated,
  `${String(openPlatformOf("zcode")?.id)} / ${countPlatforms()} vs ${platformsBeforeSimulated}`,
);

// 改名：模拟客户端那一行的地址是空串，改名不带 baseUrl 也得让过 —— 只改名字、
// 额度插件、目录那几格。
const renamedSimulated = await guard(() => updatePlatform({ id: "minimax", label: "MM" }));
check("模拟客户端的行改得动名字", renamedSimulated !== null, show(renamedSimulated));
const simulatedEdited = openPlatformOf("minimax");
check("名字改了", simulatedEdited?.label === "MM", show(simulatedEdited?.label));
check("地址还是空串", simulatedEdited?.baseUrl === "", show(simulatedEdited?.baseUrl));
check(
  "kind 与区域不变",
  simulatedEdited?.kind === "minimax" && simulatedEdited?.region === "cn",
  show([simulatedEdited?.kind, simulatedEdited?.region]),
);
// 改回来：后面几节把它当模板平台的对照，名字照目录。
const renamedBack = await guard(() => updatePlatform({ id: "minimax", label: SIMULATED_CLIENTS[0].label }));
check("改回去也改得动", renamedBack !== null, show(renamedBack));

/* ------------------------------------------------------------------ *
 * 5. 刷新目录
 * ------------------------------------------------------------------ */

section("刷新目录");

const refreshCreated = await guard(() => addPlatform({
  id: "refresh-demo",
  label: "Refresh Demo",
  baseUrl: upstreamBase,
}));
check("平台建得起来", refreshCreated !== null, errDetail());
const refreshAccount = addAccount({ platform: "refresh-demo" });
check("账号加得起来", refreshAccount.ok === true, refreshAccount.message);
setProviderKeys(refreshAccount.id ?? "", ["sk-refresh-demo"]);

const refreshed = await refreshPlatformModels({ platformId: "refresh-demo" });
check("目录拉到了", refreshed.ok === true, refreshed.message);
check("拉到的就是上游答的那份", (refreshed.models ?? []).join(",") === "fake-1", show(refreshed.models));
check(
  "库里的清单也是它",
  openPlatformOf("refresh-demo")?.models.items.join(",") === "fake-1",
  show(openPlatformOf("refresh-demo")?.models.items),
);
// 拉过的那一份：三格都跟着走（拉取时刻不是 0，来源是自动拉的）。
const refreshedListed = (await listUpstreams()).find((u) => u.id === "refresh-demo");
check(
  "ListUpstreams 报的是拉到的清单",
  (refreshedListed?.models ?? []).join(",") === "fake-1",
  show(refreshedListed?.models),
);
check(
  "ListUpstreams 报的是拉目录的时刻",
  Number(refreshedListed?.modelsFetchedAtMs ?? 0n) > 0,
  show(refreshedListed?.modelsFetchedAtMs),
);

// 上游答 500：拉不到不是错误，原来那份留着。
modelsStatus = 500;
const failed = await refreshPlatformModels({ platformId: "refresh-demo" });
check("上游答 500 时报失败", failed.ok === false, failed.message);
check(
  "原来那份清单留着",
  openPlatformOf("refresh-demo")?.models.items.join(",") === "fake-1",
  show(openPlatformOf("refresh-demo")?.models.items),
);
modelsStatus = 200;

/* ------------------------------------------------------------------ *
 * 6. 额度插件
 * ------------------------------------------------------------------ */

section("额度插件");

const plugins = await listQuotaPlugins();
const qiniu = (plugins.plugins ?? []).find((p) => p.id === "qiniu");
check("七牛那个插件在", Boolean(qiniu), show((plugins.plugins ?? []).map((p) => p.id)));
check("它的名字是七牛云资源包", qiniu?.label === "七牛云资源包", String(qiniu?.label));
check("它要的那一段凭据叫 account", qiniu?.fields?.[0]?.name === "account", show(qiniu?.fields?.[0]));
check("那一段要遮起来显示", qiniu?.fields?.[0]?.secret === true, show(qiniu?.fields?.[0]));

// 每一格的名字只有一处产出：插件自己的声明。契约上发出去的必须就是它 ——
// 面板拿它画那一格，凭据行上的 label 也是同一个值。逐个插件逐段比，不手写
// 一份「应当叫什么」：手写的那份就是第二套词的源头。
const { allQuotaPlugins } = await import("../lib/quota-plugins.ts");
for (const declared of allQuotaPlugins()) {
  const sent = (plugins.plugins ?? []).find((p) => p.id === declared.id);
  check(`插件 ${declared.id}：上了契约`, Boolean(sent), declared.id);
  if (!sent) continue;
  check(
    `插件 ${declared.id}：名字与声明一致`,
    sent.label === declared.label,
    `契约 ${sent.label}，声明 ${declared.label}`,
  );
  check(
    `插件 ${declared.id}：段数与声明一致`,
    (sent.fields ?? []).length === declared.fields.length,
    `契约 ${(sent.fields ?? []).length}，声明 ${declared.fields.length}`,
  );
  declared.fields.forEach((field, i) => {
    const got = sent.fields?.[i];
    check(
      `插件 ${declared.id}：第 ${i + 1} 格的名字就是声明里的 label`,
      got?.name === field.name && got?.label === field.label && got?.secret === field.secret,
      `契约 ${show(got)}，声明 ${show(field)}`,
    );
  });
}

/* ------------------------------------------------------------------ *
 * 7. 策略对开放平台生效
 * ------------------------------------------------------------------ */

section("策略");

const policyCreated = await guard(() => addPlatform({
  id: "policy-demo",
  label: "Policy Demo",
  baseUrl: "https://api.policy.test/v1",
}));
check("平台建得起来", policyCreated !== null, errDetail());

const setPolicy = await setPlatformPolicy({ platform: "policy-demo", policy: ProviderPolicy.FALLBACK });
check("策略改得掉", setPolicy.ok === true, setPolicy.message);
const policyUpstream = (await listUpstreams()).find((u) => u.id === "policy-demo");
check("ListUpstreams 报的是降级", policyUpstream?.policy === ProviderPolicy.FALLBACK, String(policyUpstream?.policy));
check(
  "它支持降级这个策略",
  (policyUpstream?.policies ?? []).includes(ProviderPolicy.FALLBACK),
  show(policyUpstream?.policies),
);

/* ------------------------------------------------------------------ *
 * 8. 模板平台上的三个新字段 + from_row
 * ------------------------------------------------------------------ */

section("模板平台");

const templateUpstream = (await listUpstreams()).find((u) => u.id === SIMULATED_CLIENTS[0].id);
check("模板平台的额度插件是空串", templateUpstream?.quotaPlugin === "", show(templateUpstream?.quotaPlugin));
check("模板平台不是开放平台", templateUpstream?.isOpenPlatform === false, show(templateUpstream?.isOpenPlatform));
// 但它有表里的那一行（播种补的）：面板要能改名字、删它。isOpenPlatform 说的是
// 「地址与额度插件归用户填」—— 两件事分开报，否则拿 isOpenPlatform 当判据的
// 面板上，模拟客户端那一族没有编辑与删除入口。
check("模拟客户端的 from_row 是 true", templateUpstream?.fromRow === true, show(templateUpstream?.fromRow));
check("模拟客户端的地址是空串", templateUpstream?.baseUrl === "", show(templateUpstream?.baseUrl));

/* ------------------------------------------------------------------ *
 * 8b. from_row：列出来的平台都有表里那一行
 * ------------------------------------------------------------------ */

section("from_row");

// 代码里的模板名单已经空了（平台全在表里），所以列出来的每一个平台都能在表里
// 找到自己那一行 —— 「只有代码、没有行」那一族现在一个都没有。哪天代码里再
// 出现只存在于代码的模板，这一条会红：那时要改的是这一条断言（那族按设计
// 删不掉），不是把 from_row 报成 true 把它们描过去。
check("代码里的模板名单是空的", PLATFORMS.length === 0, show(PLATFORMS.map((p) => p.id)));
const listed = await listUpstreams();
check(
  "列出来的每个平台都有表里那一行",
  listed.every((u) => u.fromRow === true),
  show(listed.filter((u) => u.fromRow !== true).map((u) => u.id)),
);
check(
  "它们也是表里有的",
  listed.every((u) => openPlatformOf(u.id) !== null),
  show(listed.filter((u) => openPlatformOf(u.id) === null).map((u) => u.id)),
);

/* ------------------------------------------------------------------ *
 * 9. 模型目录三格：开放平台报的是平台行里的那份，模板平台是空
 * ------------------------------------------------------------------ */

section("模型目录三格");

check(
  "模板平台的目录是空的",
  (templateUpstream?.models ?? []).length === 0,
  show(templateUpstream?.models),
);
check(
  "模板平台的拉取时刻是 0",
  templateUpstream?.modelsFetchedAtMs === 0n,
  show(templateUpstream?.modelsFetchedAtMs),
);

/* ------------------------------------------------------------------ *
 * 10. 地址：开放平台没账号时也报地址；模板平台照旧
 * ------------------------------------------------------------------ */

section("地址");

// 开放平台：建好，但一个账号都不加。
const addressDemo = await guard(() => addPlatform({
  id: "address-demo",
  label: "Address Demo",
  baseUrl: "https://api.address.test/v1",
}));
check("平台建得起来", addressDemo !== null, errDetail());
check("它名下没有账号", providersOf("address-demo") === 0, String(providersOf("address-demo")));

const addressListed = (await listUpstreams()).find((u) => u.id === "address-demo");
check(
  "没有账号时地址也是建的时候填的那个",
  addressListed?.baseUrl === "https://api.address.test/v1",
  show(addressListed?.baseUrl),
);
check(
  "它报的是开放平台",
  addressListed?.isOpenPlatform === true,
  show(addressListed?.isOpenPlatform),
);
check(
  "地址跟库里那一行一样",
  addressListed?.baseUrl === openPlatformOf("address-demo")?.baseUrl,
  show([addressListed?.baseUrl, openPlatformOf("address-demo")?.baseUrl]),
);

// 对照：模板平台的地址还是从名下账号的 kind 算的，一个字没变。
// qoder 名下有账号（上面加过），所以它有地址。
const qoderListed = (await listUpstreams()).find((u) => u.id === "qoder");
check(
  "模板平台的地址还是 upstreamBaseUrl 给的那一份",
  qoderListed?.baseUrl === upstreamBaseUrl("qoder"),
  show([qoderListed?.baseUrl, upstreamBaseUrl("qoder")]),
);
check("模板平台的地址不是空串", Boolean(qoderListed?.baseUrl), show(qoderListed?.baseUrl));

/* ------------------------------------------------------------------ *
 * 15. models_from_upstream：逐 kind 的答案
 * ------------------------------------------------------------------ */

section("模型目录归不归上游");

// 六个厂商/方言平台 + 一个模拟客户端。opencode-go 不在代码模板里（它是用户自己
// 建的那类），所以现建一个。
// 厂商那几行不再由代码补（平台行是用户在面板上自己建的）：这一节要比的那几行，
// 测试自己造一行。
const { insertVendorPlatform } = await import("./vendor-platform.ts");
insertVendorPlatform("qiniu");
insertVendorPlatform("xinghuo", "xinghuo");
insertVendorPlatform("sensenova");
insertVendorPlatform("intern-ai");
insertVendorPlatform("tokenrhythm");

const catalogOwner = await guard(() => addPlatform({
  id: "opencode-go",
  kind: "openai",
  label: "OpenCode Go",
  baseUrl: "https://api.opencode-go.test/v1",
}));
check("opencode-go 建得起来", catalogOwner !== null, show(catalogOwner));

const ownerListed = await listUpstreams();

// 一个平台一个答案，判据只有平台的族：方言族的目录归上游，模拟客户端那一族的
// 目录由代码给出。
const catalogOwners: Array<[string, string, boolean]> = [
  ["opencode-go", "openai", true],
  ["qiniu", "qiniu", true],
  ["xinghuo", "xinghuo", true],
  ["sensenova", "sensenova", true],
  ["intern-ai", "intern-ai", true],
  ["tokenrhythm", "tokenrhythm", true],
  ["minimax", "minimax", false],
];
check(
  "七个平台都在列表里（不然下面几条比的都是 undefined）",
  catalogOwners.every(([id]) => ownerListed.some((u) => u.id === id)),
  show(catalogOwners.filter(([id]) => !ownerListed.some((u) => u.id === id)).map(([id]) => id)),
);
for (const [id, kind, want] of catalogOwners) {
  const category = platformCategoryOfKind(kind);
  check(
    `${id}：${want ? "目录从上游拉" : "目录由代码给出"}（族是判据）`,
    (category === "dialect") === want,
    show([category, platformCategoryOfKind(kind)]),
  );
}

/* ------------------------------------------------------------------ *
 * 16. 目录写不进去：models / modelsAuto 那几格在写入口（数据层）被忽略
 * ------------------------------------------------------------------ */

section("目录写不进去（模拟客户端那一族与方言族一样）");

const minimaxBefore = openPlatformOf("minimax");
check(
  "起点：清单是空的（那一族的目录由代码给出）",
  (minimaxBefore?.models.items ?? []).length === 0,
  show(minimaxBefore?.models),
);

// 规矩落在写入口（updateOpenPlatform）：直接调它，就跟脚本、迁移递上来的一样。
// 名字得用一个跟现值就是不同的值（起始名是预置的「MiniMax Code」），否则这一条
// 证明不了「别的格没跟着一块儿被无视」。
const ignoredLabel = "renamed minimax";
const ignored = updateOpenPlatform("minimax", {
  label: ignoredLabel,
  models: ["x"],
  modelsAuto: true,
} as never);
check("数据层送目录不报错", ignored.ok === true, ignored.message);

const minimaxAfter = openPlatformOf("minimax");
check("库里的清单还是空的", (minimaxAfter?.models.items ?? []).length === 0, show(minimaxAfter?.models));
// 同一单里的 label 得落库：不认的只有目录那几格，别的格不能跟着不生效。
check("同一单里的名字改了", minimaxAfter?.label === ignoredLabel, show(minimaxAfter?.label));

// 端到端一条：面板那条路照面板的形状送（模拟客户端发的是空清单），也得是
// 「成功返回、目录没动」。
const panelShape = await guard(() =>
  updatePlatform({ id: "minimax", label: ignoredLabel, modelsAuto: false, models: [] } as never),
);
check("面板那条路照常成功", panelShape !== null, `${errCode()} / ${errDetail()}`);
check("答复里带着这个平台", panelShape?.platform?.id === "minimax", show(panelShape?.platform));
const panelShapeRow = openPlatformOf("minimax");
check(
  "面板那条路也没写坏（清单还是空）",
  (panelShapeRow?.models.items ?? []).length === 0,
  show(panelShapeRow?.models),
);
const minimaxListed = (await listUpstreams()).find((u) => u.id === "minimax");
check(
  "ListUpstreams 里报的也是空清单",
  (minimaxListed?.models ?? []).length === 0,
  show(minimaxListed?.models),
);

// 对照：方言族的行也一样写不进去 —— 目录只有上游那一份。
const control = await guard(() => updatePlatform({ id: "opencode-go", models: ["m-1"] } as never));
check("对照：面板送目录过去也走得通", control !== null, show(control));
const controlRow = openPlatformOf("opencode-go");
check(
  "对照：目录仍然写不进去（只有上游那一份）",
  (controlRow?.models.items ?? []).length === 0,
  show(controlRow?.models),
);

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

upstream.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (fail === 0) {
  console.log(`全部通过（${pass} 项）`);
} else {
  console.log(`FAIL: ${fail} 项没过，${pass} 项过了`);
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
