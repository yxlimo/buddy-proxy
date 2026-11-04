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
//   2. AddPlatform 的三种拒绝：id 不合法、跟代码模板重名、重复建
//   3. UpdatePlatform：改名生效、地址空串被拒且库没变、额度插件写进去、
//      手工目录（models_auto=false + 清单）写进去
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
//
// 断言里不写死平台的个数：一律跟表里的行数比。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "open-platform-admin-"));
process.env.BUDDY_DATA_DIR = tmp;

const { adminService } = await import("../lib/admin/service.ts");
const { store } = await import("../lib/store.ts");
const { openPlatformOf } = await import("../lib/open-platforms.ts");
const { PLATFORMS } = await import("../lib/platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { upstreamBaseUrl } = await import("../lib/admin/upstreams.ts");
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
const added = await addPlatform({
  id: "acme",
  label: "Acme",
  baseUrl: "https://api.acme.test/v1",
});
check("开放平台加得进去", added.ok === true, added.message);
check("加的时候说了句话", String(added.message ?? "").length > 0, String(added.message));
check("库里的平台多了一行", countPlatforms() === platformsBefore + 1, `${countPlatforms()} vs ${platformsBefore}`);
check("答复里带着这个平台", added.platform?.id === "acme", show(added.platform));

const upstreams = await listUpstreams();
const acme = upstreams.find((u) => u.id === "acme");
check("ListUpstreams 里有它", Boolean(acme), show(upstreams.map((u) => u.id)));
check("它是一个开放平台", acme?.isOpenPlatform === true, show(acme?.isOpenPlatform));
check("没有账号时状态是没有凭据", acme?.state === UpstreamState.NO_CREDENTIAL, String(acme?.state));
check("额度插件那一格是空的", acme?.quotaPlugin === "", show(acme?.quotaPlugin));
check("新加的平台默认自动拉目录", acme?.modelsAuto === true, show(acme?.modelsAuto));
// 模型目录三格：报的是平台行里的那份（刚建的平台还没有目录）。
const acmeRow = openPlatformOf("acme");
check("新加的平台目录是空的", (acme?.models ?? []).length === 0, show(acme?.models));
check("新加的平台没拉过目录", acme?.modelsFetchedAtMs === 0n, show(acme?.modelsFetchedAtMs));
check(
  "目录来源跟库里那一行一样",
  acme?.modelsSource === acmeRow?.models.source,
  show([acme?.modelsSource, acmeRow?.models.source]),
);

/* ------------------------------------------------------------------ *
 * 2. 加平台：四种拒绝
 * ------------------------------------------------------------------ */

section("加平台：拒绝");

const badId = await addPlatform({
  id: "Acme_Bad",
  label: "不合法",
  baseUrl: "https://api.acme.test/v1",
});
check("id 不合法被拒", badId.ok === false, show(badId));
check("说的是 id 的规矩", String(badId.message ?? "").length > 0, String(badId.message));

const templateClash = await addPlatform({
  id: PLATFORMS[0].id,
  label: "撞模板",
  baseUrl: "https://api.acme.test/v1",
});
check("跟代码模板重名被拒", templateClash.ok === false, show(templateClash));
check(
  "说的是代码里的平台",
  String(templateClash.message ?? "").includes("代码里的平台"),
  String(templateClash.message),
);

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

const again = await addPlatform({
  id: "acme",
  label: "又一个",
  baseUrl: "https://api.acme.test/v1",
});
check("重复建被拒", again.ok === false, show(again));
check("说的是已经有了", String(again.message ?? "").length > 0, String(again.message));
check(
  "被拒的那些都没写进表",
  countPlatforms() === platformsBefore + 1,
  `${countPlatforms()} vs ${platformsBefore + 1}`,
);

/* ------------------------------------------------------------------ *
 * 3. 改平台
 * ------------------------------------------------------------------ */

section("改平台");

const renamed = await updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
});
check("改名改得掉", renamed.ok === true, renamed.message);
check("名字改了", openPlatformOf("acme")?.label === "Acme Cloud", String(openPlatformOf("acme")?.label));

const emptyBase = await updatePlatform({ id: "acme", label: "Acme Cloud", baseUrl: "" });
check("地址空串被拒", emptyBase.ok === false, show(emptyBase));
check("说得清为什么", String(emptyBase.message ?? "").length > 0, String(emptyBase.message));
check(
  "库里的地址没变",
  openPlatformOf("acme")?.baseUrl === "https://api.acme.test/v1",
  String(openPlatformOf("acme")?.baseUrl),
);
check("库里的名字没变", openPlatformOf("acme")?.label === "Acme Cloud", String(openPlatformOf("acme")?.label));

const withPlugin = await updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "qiniu",
});
check("额度插件写得进去", withPlugin.ok === true, withPlugin.message);
check("插件写进库里了", openPlatformOf("acme")?.quotaPlugin === "qiniu", String(openPlatformOf("acme")?.quotaPlugin));
const withPluginListed = (await listUpstreams()).find((u) => u.id === "acme");
check(
  "ListUpstreams 报的是那个插件",
  withPluginListed?.quotaPlugin === "qiniu",
  show(withPluginListed?.quotaPlugin),
);

// 没登记的插件 id：拒绝保存。收下去之后这个平台一条额度结论都不会有，而面板上
// 看着「已选插件」—— 静默不工作比拒绝保存更难查。
const badPlugin = await updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "qiniu-portal",
});
check("没登记的插件 id 被拒", badPlugin.ok === false, show(badPlugin));
check(
  "说的是没有这个额度插件",
  String(badPlugin.message ?? "").includes("没有这个额度插件：qiniu-portal"),
  String(badPlugin.message),
);
check(
  "列了登记过的插件（用插件自己的名字）",
  String(badPlugin.message ?? "").includes("七牛云资源包") && String(badPlugin.message ?? "").includes("qiniu"),
  String(badPlugin.message),
);
// 被拒的那次什么都没写：库里、ListUpstreams、答复里带回来的平台都是原来那个。
check("被拒时答复里没有平台", badPlugin.platform === undefined, show(badPlugin.platform));
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
const clearedPlugin = await updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "",
});
check("空串 = 不选插件，收得下", clearedPlugin.ok === true, clearedPlugin.message);
check("插件那一格清掉了", openPlatformOf("acme")?.quotaPlugin === "", String(openPlatformOf("acme")?.quotaPlugin));
check(
  "ListUpstreams 报的是空串",
  (await listUpstreams()).find((u) => u.id === "acme")?.quotaPlugin === "",
  show((await listUpstreams()).find((u) => u.id === "acme")?.quotaPlugin),
);
// 清完再选回来：下面的手工目录那一节要用带插件的平台。
const restoredPlugin = await updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "qiniu",
});
check("登记的插件选得回来", restoredPlugin.ok === true, restoredPlugin.message);

// AddPlatform 现在不接 quota_plugin：契约里 AddPlatformRequest 只有 id、名字、
// 地址三格。所以“加平台时写插件”本来就没路，想加插件得建完再 UpdatePlatform；
// 将来接了这一格也得走同一校验。这条断言钉的就是“现在不接”：请求里塞了也不
// 进库。
const addedWithPlugin = await addPlatform({
  id: "acme-plugin-ignored",
  label: "带插件的加平台",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "no-such-plugin",
});
check("加平台不看 quota_plugin（契约里没这一格）", addedWithPlugin.ok === true, addedWithPlugin.message);
check(
  "所以没登记的插件带不进库",
  openPlatformOf("acme-plugin-ignored")?.quotaPlugin === "",
  String(openPlatformOf("acme-plugin-ignored")?.quotaPlugin),
);
// 这个平台只是为了上面那两条断言：删掉，免得影响后面按行数比的那几节。
const droppedExtra = await deletePlatform({ id: "acme-plugin-ignored" });
check("为了那条断言建的平台删得掉", droppedExtra.ok === true, droppedExtra.message);

const manual = await updatePlatform({
  id: "acme",
  label: "Acme Cloud",
  baseUrl: "https://api.acme.test/v1",
  quotaPlugin: "qiniu",
  modelsAuto: false,
  models: ["m-1", "m-2"],
});
check("手工目录写得进去", manual.ok === true, manual.message);
const manualRow = openPlatformOf("acme");
check("清单是那两份", manualRow?.models.items.join(",") === "m-1,m-2", show(manualRow?.models));
check("自动拉关掉了", manualRow?.models.auto === false, show(manualRow?.models));
check("来源是人写的", manualRow?.models.source === "manual", show(manualRow?.models));
const manualListed = (await listUpstreams()).find((u) => u.id === "acme");
check("ListUpstreams 里自动那一格是 false", manualListed?.modelsAuto === false, show(manualListed?.modelsAuto));
check(
  "ListUpstreams 报的是那两份清单",
  (manualListed?.models ?? []).join(",") === "m-1,m-2",
  show(manualListed?.models),
);
check(
  "ListUpstreams 报的是来源是人写的",
  manualListed?.modelsSource === "manual",
  show(manualListed?.modelsSource),
);
check(
  "ListUpstreams 报的是没拉过目录",
  manualListed?.modelsFetchedAtMs === 0n,
  show(manualListed?.modelsFetchedAtMs),
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
const deleted = await deletePlatform({ id: "acme" });
check("平台删得掉", deleted.ok === true, deleted.message);
check("说得清删了什么", String(deleted.message ?? "").length > 0, String(deleted.message));
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
check(
  "删的时候说了那几个模型",
  String(deleted.message ?? "").includes("已发布模型"),
  String(deleted.message),
);

const templateDelete = await deletePlatform({ id: PLATFORMS[0].id });
check("模板平台删不掉", templateDelete.ok === false, show(templateDelete));
check(
  "说的是代码里的平台",
  String(templateDelete.message ?? "").includes("代码里的平台"),
  String(templateDelete.message),
);

const missingDelete = await deletePlatform({ id: "no-such-platform" });
check("删不存在的平台会说不存在", missingDelete.ok === false, show(missingDelete));
check(
  "说的是没有这个平台",
  String(missingDelete.message ?? "").includes("没有这个平台"),
  String(missingDelete.message),
);

/* ------------------------------------------------------------------ *
 * 5. 刷新目录
 * ------------------------------------------------------------------ */

section("刷新目录");

const refreshCreated = await addPlatform({
  id: "refresh-demo",
  label: "Refresh Demo",
  baseUrl: upstreamBase,
});
check("平台建得起来", refreshCreated.ok === true, refreshCreated.message);
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
  "ListUpstreams 报的是自动拉的",
  refreshedListed?.modelsSource === "auto",
  show(refreshedListed?.modelsSource),
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
check("那一段叫门户 cookie", qiniu?.fields?.[0]?.label === "门户 cookie", show(qiniu?.fields?.[0]));
check("那一段要遮起来显示", qiniu?.fields?.[0]?.secret === true, show(qiniu?.fields?.[0]));

/* ------------------------------------------------------------------ *
 * 7. 策略对开放平台生效
 * ------------------------------------------------------------------ */

section("策略");

const policyCreated = await addPlatform({
  id: "policy-demo",
  label: "Policy Demo",
  baseUrl: "https://api.policy.test/v1",
});
check("平台建得起来", policyCreated.ok === true, policyCreated.message);

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
 * 8. 模板平台上的三个新字段
 * ------------------------------------------------------------------ */

section("模板平台");

const templateUpstream = (await listUpstreams()).find((u) => u.id === PLATFORMS[0].id);
check("模板平台的额度插件是空串", templateUpstream?.quotaPlugin === "", show(templateUpstream?.quotaPlugin));
check("模板平台的自动拉是 false", templateUpstream?.modelsAuto === false, show(templateUpstream?.modelsAuto));
check("模板平台不是开放平台", templateUpstream?.isOpenPlatform === false, show(templateUpstream?.isOpenPlatform));

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
  "模板平台的目录来源是空串",
  templateUpstream?.modelsSource === "",
  show(templateUpstream?.modelsSource),
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
const addressDemo = await addPlatform({
  id: "address-demo",
  label: "Address Demo",
  baseUrl: "https://api.address.test/v1",
});
check("平台建得起来", addressDemo.ok === true, addressDemo.message);
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
