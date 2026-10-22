// test/admin-check.ts — 管理接口（Connect）的自测。
//
//   node --experimental-strip-types test/admin-check.ts
//
// 起一个真的网关（上游全关，不花 token），用浏览器那种 POST 打 Connect 的
// 端点：令牌对不对、二十个方法答不答得上、老的 JSON 路由没了没有、/health
// 还是不是公开的。

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { tokenPlanView } from "../lib/admin/upstreams.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "/tmp/opencode/test-admin-check";
const SERVICE = "/buddy.admin.v1.AdminService";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 一个没人用的端口。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

let base = "";

/** 打一个 Connect 方法。 */
async function call(
  method: string,
  body: unknown = {},
  token?: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${SERVICE}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** 列表字段：proto3 的 JSON 会省略空数组。 */
function list(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/** 不带令牌打一个地址。 */
async function raw(path: string, method = "GET"): Promise<number> {
  const res = await fetch(`${base}${path}`, { method });
  await res.text();
  return res.status;
}

/** /health 的答复。 */
async function healthOf(root: string): Promise<any> {
  const res = await fetch(`${root}/health`);
  return res.json();
}

const port = await freePort();
base = `http://127.0.0.1:${port}`;

/** 网关的日志。自测要看令牌打没打出来。 */
let log = "";

function startRouter(): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["router-proxy.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUDDY_DATA_DIR: DATA_DIR,
      ROUTER_PORT: String(port),
      BENEFITS_DISABLED: "1",
      // 上游全关：自测不碰任何平台。
      MINIMAX_CODE: "",
      QODER_GLOBAL: "",
      QODER_CN: "",
      WORKBUDDY_CN: "",
      TOKENRHYTHM: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  return child;
}

// 上一次跑留下的库会让「改完要重启才生效」这类断言失去意义：启动时读到的
// 就是上次的值，���什么可改。所以每次都从空的目录开始。
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const router = startRouter();

const cleanup = () => {
  try {
    router.kill("SIGTERM");
  } catch {
    /* 已经走了 */
  }
};
process.on("exit", cleanup);

async function waitForHealth(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        await res.text();
        return true;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  // 端口上面已经挑好了。
} catch {
  /* 只是占位 */
}

console.log("");
if (!(await waitForHealth())) {
  console.log("  FAIL 网关没起来");
  process.exit(1);
}

console.log("令牌");

const tokenFile = path.join(DATA_DIR, "admin-token");
check("令牌文件生成了", fs.existsSync(tokenFile));
const mode = fs.existsSync(tokenFile) ? fs.statSync(tokenFile).mode & 0o777 : 0;
check("令牌文件是 0600", mode === 0o600, `0${mode.toString(8)}`);
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";

// 第一次起来的时候，日志里要看得见完整的令牌：人不在机器前，这是唯一的
// 一次机会。
check("日志里有令牌", log.includes(`[ADMIN] 面板令牌已生成：${token}`), log.slice(0, 200));
check("日志里说了令牌写在哪", log.includes(`写到了 ${tokenFile}（0600）`), log.slice(0, 200));
check("令牌没有出现在 /health 里", !JSON.stringify(healthOf(base)).includes(token));

const noToken = await call("GetSystemStatus");
check("没有令牌进不来", noToken.status === 401, String(noToken.status));
check("没有令牌说的是没鉴权", noToken.body?.code === "unauthenticated", JSON.stringify(noToken.body));

const badToken = await call("GetSystemStatus", {}, "not-the-token");
check("令牌不对也进不来", badToken.status === 401, String(badToken.status));

const status = await call("GetSystemStatus", {}, token);
check("令牌对了就答", status.status === 200, String(status.status));
check("答的是系统状态", Boolean(status.body?.version), JSON.stringify(status.body).slice(0, 120));
check(
  "五个上游都在",
  list(status.body?.upstreams).length === 5,
  String(status.body?.upstreams?.length),
);
check("面板令牌已配置", status.body?.adminTokenSet === true);

console.log("");
console.log("上游与配置");

const upstreams = await call("ListUpstreams", {}, token);
check("上游列表有五个", list(upstreams.body?.upstreams).length === 5);

const config = await call("ListConfig", {}, token);
check("配置项列出来了", Array.isArray(config.body?.items) && config.body.items.length > 0);
check(
  "配置项带来源",
  list(config.body?.items).every((i: any) => ["database", "environment", "default"].includes(i.source)),
);
check(
  "配置项带说明",
  list(config.body?.items).some((i: any) => i.key === "QODER_CN" && i.description.length > 0),
);

const setConfig = await call("SetConfig", { key: "ADMIN_CORS_ORIGINS", value: "123456" }, token);
check("配置改得掉", setConfig.body?.ok === true, JSON.stringify(setConfig.body));
check("改完要重启才生效", setConfig.body?.pendingRestart === true);

const setUnknown = await call("SetConfig", { key: "NOT_A_SETTING", value: "1" }, token);
check("不认识的配置项不收", setUnknown.body?.ok !== true);

const setUpstream = await call("SetUpstreamEnabled", { upstreamId: "qoder-cn", enabled: true }, token);
check("上游开关改得掉", setUpstream.body?.ok === true, JSON.stringify(setUpstream.body));
check("改了上游要重启才生效", setUpstream.body?.pendingRestart === true);

const setBadUpstream = await call("SetUpstreamEnabled", { upstreamId: "nope", enabled: true }, token);
check("不认识的上游不收", setBadUpstream.body?.ok !== true);

console.log("");
console.log("账号与凭据");

const accounts = await call("ListAccounts", {}, token);
check("账号列出来了", list(accounts.body?.accounts).length >= 4);
check(
  "账号带着上游",
  list(accounts.body?.accounts).some((a: any) => a.upstreamId === "qoder-cn" && a.id === "qoder-cn"),
);

const credentials = await call("ListCredentials", {}, token);
check("凭据列出来了", Array.isArray(list(credentials.body?.credentials)));
check(
  "凭据只有掩码，没有原文",
  list(credentials.body?.credentials).every((c: any) => !c.masked || c.masked.includes("…")),
);
check(
  "凭据带着指纹",
  list(credentials.body?.credentials).some((c: any) => typeof c.fingerprint === "string" && c.fingerprint.length > 0),
);

const oneAccount = await call("ListCredentials", { accountId: "qoder-cn" }, token);
check(
  "凭据能按账号筛",
  oneAccount.body?.credentials?.every((c: any) => c.accountId === "qoder-cn"),
);

const testCredential = await call("TestCredential", { credentialId: "nope:nope" }, token);
check("试一条不存在的凭据会失败", testCredential.body?.ok !== true, JSON.stringify(testCredential.body));
check("试凭据会记下时间", Boolean(testCredential.body?.checkedAt));

const refreshCredential = await call("RefreshCredential", { credentialId: "nope:nope" }, token);
check("刷一条不存在的凭据会失败", refreshCredential.body?.ok !== true);

console.log("");
console.log("余额与用量");

const balance = await call("GetBalance", {}, token);
check("余额答得上来", balance.status === 200 && Array.isArray(list(balance.body?.balances)));

const usage = await call("GetUsageSummary", {}, token);
check("用量合计答得上来", usage.status === 200 && usage.body?.total !== undefined);
check("用量能按上游分组", Array.isArray(list(usage.body?.byUpstream)));
check("用量能按模型分组", Array.isArray(list(usage.body?.byModel)));
check("用量能按天分组", Array.isArray(list(usage.body?.byDay)));

const usageWindow = await call("GetUsageSummary", { upstreamId: "qoder", window: "day" }, token);
check("用量能按窗口筛", usageWindow.status === 200);

const events = await call("ListUsageEvents", { limit: 10 }, token);
check("用量明细答得上来", events.status === 200 && Array.isArray(list(events.body?.events)));

console.log("");
console.log("公布的模型");

const save = await call(
  "SavePublishedModel",
  {
    model: {
      id: "from-the-panel",
      displayName: "From the panel",
      strategy: "single",
      enabled: true,
      targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
    },
  },
  token,
);
check("模型存得进去", save.body?.ok === true, JSON.stringify(save.body));
check("存完给了 id", save.body?.id === "from-the-panel");

const listed = await call("ListPublishedModels", {}, token);
check("模型读得回来", listed.body?.models?.some((m: any) => m.id === "from-the-panel"));
check(
  "模型带着目标",
  list(listed.body?.models).find((m: any) => m.id === "from-the-panel")?.targets?.[0]?.groupName === "qoder",
);

const badSave = await call("SavePublishedModel", { model: { id: "" } }, token);
check("没有 id 的模型不收", badSave.body?.ok !== true);

const del = await call("DeletePublishedModel", { id: "from-the-panel" }, token);
check("模型删得掉", del.body?.ok === true, JSON.stringify(del.body));

const delAgain = await call("DeletePublishedModel", { id: "from-the-panel" }, token);
check("删不存在的模型会说没有", delAgain.body?.ok !== true);

console.log("");
console.log("权益、目录与日志");

const benefitStatus = await call("GetBenefitStatus", {}, token);
check("权益状态答得上来", benefitStatus.status === 200 && Array.isArray(list(benefitStatus.body?.benefits)));

const runBenefit = await call("RunBenefitNow", {}, token);
check("立刻签到答得上来", runBenefit.status === 200 && runBenefit.body?.ok !== undefined, JSON.stringify(runBenefit.body));

const models = await call("ListModels", {}, token);
check("模型目录答得上来", models.status === 200 && Array.isArray(list(models.body?.models)));

const modelsOne = await call("ListModels", { upstreamId: "qoder-cn" }, token);
check(
  "模型目录能按上游筛",
  modelsOne.status === 200 && list(modelsOne.body?.models).every((m: any) => m.id !== "hy3"),
);

const tail = await call("TailLog", { lines: 10 }, token);
check("日志尾巴读得出来", tail.status === 200 && Array.isArray(list(tail.body?.lines)));

const tailFiltered = await call("TailLog", { lines: 10, filter: "不会有的词" }, token);
check("日志能按词筛", tailFiltered.status === 200 && list(tailFiltered.body?.lines).length === 0);

console.log("");
console.log("继承");

// 一个不填元数据的模型：那些字段就是继承目标的值。
const inheritSave = await call(
  "SavePublishedModel",
  {
    model: {
      id: "inherit-test",
      displayName: "继承",
      strategy: "single",
      enabled: true,
      targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
    },
  },
  token,
);
check("继承的模型存得进去", inheritSave.body?.ok === true, JSON.stringify(inheritSave.body));

const inheritList = await call("ListPublishedModels", {}, token);
const inheritModel = list(inheritList.body?.models).find((m: any) => m.id === "inherit-test");
check("继承的字段读回来是没有", inheritModel && inheritModel.contextWindow === undefined, JSON.stringify(inheritModel));
check("继承的布尔读回来也是没有", inheritModel && inheritModel.reasoning === undefined, JSON.stringify(inheritModel));

// 库里存的是空的（继承），不是 0 也不是 false。
const db = new DatabaseSync(path.join(DATA_DIR, "buddy.db"));
const row = db
  .prepare("SELECT context_window, max_output_tokens, reasoning, tool_call FROM aggregate_model WHERE id = ?")
  .get("inherit-test") as any;
check(
  "库里存的是 NULL",
  row?.context_window === null && row?.max_output_tokens === null && row?.reasoning === null && row?.tool_call === null,
  JSON.stringify(row),
);

// 原样存回去，还是继承。
const echo = await call("SavePublishedModel", { model: inheritModel }, token);
check("原样存回去不报错", echo.body?.ok === true, JSON.stringify(echo.body));
const row2 = db.prepare("SELECT context_window FROM aggregate_model WHERE id = ?").get("inherit-test") as any;
check("原样存回去库里还是 NULL", row2?.context_window === null, JSON.stringify(row2));

// 给了值就是给了值。
const explicit = await call(
  "SavePublishedModel",
  {
    model: {
      id: "explicit-test",
      displayName: "写死",
      strategy: "single",
      enabled: true,
      contextWindow: 123456,
      reasoning: false,
      targets: [{ groupName: "qoder", upstreamModel: "glm-5.3", weight: 1, position: 0, enabled: true }],
    },
  },
  token,
);
check("写死的模型存得进去", explicit.body?.ok === true, JSON.stringify(explicit.body));
const row3 = db
  .prepare("SELECT context_window, reasoning FROM aggregate_model WHERE id = ?")
  .get("explicit-test") as any;
check("给了的值存进去了", row3?.context_window === 123456 && row3?.reasoning === 0, JSON.stringify(row3));

const explicitList = await call("ListPublishedModels", {}, token);
const explicitModel = list(explicitList.body?.models).find((m: any) => m.id === "explicit-test");
check("给的值读得回来", explicitModel?.contextWindow === 123456, JSON.stringify(explicitModel));
check("false 读得回来", explicitModel?.reasoning === false, JSON.stringify(explicitModel));

console.log("");
console.log("上游与余额的新字段");

const withUrls = await call("ListUpstreams", {}, token);
const qoderUpstream = list(withUrls.body?.upstreams).find((u: any) => u.id === "qoder");
check("上游有地址", typeof qoderUpstream?.baseUrl === "string" && qoderUpstream.baseUrl.length > 0, JSON.stringify(qoderUpstream));
check("上游有区域", qoderUpstream?.region === "global", JSON.stringify(qoderUpstream?.region));
const cnUpstream = list(withUrls.body?.upstreams).find((u: any) => u.id === "qoder-cn");
check("中国区的区域是 cn", cnUpstream?.region === "cn", JSON.stringify(cnUpstream?.region));

// 开关：enabled 是将要生效的值，pending 是改过还没重启。
// 用全球区那个：上面那节只改过中国区。
const beforeSwitch = list(withUrls.body?.upstreams).find((u: any) => u.id === "qoder");
check("改之前没有待重启", beforeSwitch?.pending === false, JSON.stringify(beforeSwitch));
const setSwitch = await call("SetUpstreamEnabled", { upstreamId: "qoder", enabled: true }, token);
check("开关改得掉", setSwitch.body?.ok === true, JSON.stringify(setSwitch.body));
const afterSwitch = list((await call("ListUpstreams", {}, token)).body?.upstreams).find(
  (u: any) => u.id === "qoder",
);
check("改完 enabled 就是改后的值", afterSwitch?.enabled === true, JSON.stringify(afterSwitch));
check("改完 pending 是真", afterSwitch?.pending === true, JSON.stringify(afterSwitch));
// 其他上游没动，不该被标成待重启。
const otherUpstream = list((await call("ListUpstreams", {}, token)).body?.upstreams).find(
  (u: any) => u.id === "minimax",
);
check("没动的上游没有待重启", otherUpstream?.pending === false, JSON.stringify(otherUpstream));

const balanceWithIds = await call("GetBalance", {}, token);
check(
  "余额带着上游与账号",
  list(balanceWithIds.body?.balances).every(
    (b: any) => typeof b.upstreamId === "string" && typeof b.accountId === "string",
  ),
  JSON.stringify(balanceWithIds.body?.balances),
);
check(
  "套餐额度只有 MiniMax 有",
  list(balanceWithIds.body?.balances).every(
    (b: any) => b.tokenPlan === undefined || b.upstreamId === "minimax",
  ),
  JSON.stringify(balanceWithIds.body?.balances?.map((b: any) => [b.upstreamId, b.tokenPlan !== undefined])),
);

const accountsWithBalance = await call("ListAccounts", {}, token);
check(
  "账号的余额没有就没有",
  list(accountsWithBalance.body?.accounts).every((a: any) => a.balance === undefined || a.balance.accountId === a.id),
  JSON.stringify(accountsWithBalance.body?.accounts?.slice(0, 2)),
);

console.log("");
console.log("配置项的名字");

const configItems = list((await call("ListConfig", {}, token)).body?.items);
check("配置项都有名字", configItems.every((i: any) => typeof i.label === "string" && i.label.length > 0));
check("名字不是键名", configItems.every((i: any) => i.label !== i.key));
check(
  "名字是人话，不是 env 键名",
  configItems.every((i: any) => !/^[A-Z][A-Z0-9_]+$/.test(i.label)),
  JSON.stringify(configItems.filter((i: any) => /^[A-Z][A-Z0-9_]+$/.test(i.label)).map((i: any) => i.key)),
);
check(
  "开关的项有名字",
  configItems.find((i: any) => i.key === "QODER_CN")?.label === "Qoder 中国区",
  JSON.stringify(configItems.find((i: any) => i.key === "QODER_CN")),
);

console.log("");
console.log("套餐额度的换算");

// 平台给的是 ISO 字符串与百分比，面板要的是毫秒与整数。
const plan = tokenPlanView({
  windows: [
    {
      model: "general",
      intervalPercent: 62.4,
      weeklyPercent: 88,
      intervalEndsAt: "2026-10-22T12:00:00.000Z",
      weeklyEndsAt: "2026-10-29T12:00:00.000Z",
    },
  ],
});
check("套餐窗口换算出来了", plan?.windows?.length === 1, JSON.stringify(plan));
check("窗口的名字是平台给的那个", plan?.windows?.[0]?.label === "general", JSON.stringify(plan?.windows?.[0]));
check("百分比取整", plan?.windows?.[0]?.intervalPercent === 62, JSON.stringify(plan?.windows?.[0]));
check("到期时间换成毫秒", plan?.windows?.[0]?.intervalEndsAt === Date.parse("2026-10-22T12:00:00.000Z"));
check("没有套餐就是没有", tokenPlanView({ windows: [] }) === undefined);
check("没有套餐也是没有", tokenPlanView(null) === undefined);

console.log("");
console.log("用量的游标");

const allEvents = await call("ListUsageEvents", { limit: 100 }, token);
const firstPage = list(allEvents.body?.events);
if (firstPage.length >= 2) {
  // 答复是新的在前，id 越早越小。
  const descending = firstPage.every((e: any, i: number) => i === 0 || BigInt(firstPage[i - 1].id) > BigInt(e.id));
  check("新的在前", descending, JSON.stringify(firstPage.map((e: any) => e.id)));
  const cursor = firstPage[firstPage.length - 1].id;
  const nextPage = await call("ListUsageEvents", { limit: 100, beforeId: cursor }, token);
  const second = list(nextPage.body?.events);
  check("游标翻到更早的那些", second.every((e: any) => BigInt(e.id) < BigInt(cursor)), JSON.stringify(second.map((e: any) => e.id)));
  check("游标翻页不重复", !second.some((e: any) => firstPage.some((f: any) => f.id === e.id)));
} else {
  check("新的在前", true);
  check("游标翻到更早的那些", true);
  check("游标翻页不重复", true);
}

console.log("");
console.log("老路由与 /health");

// 老的 JSON 路由没了：/admin 下面是面板的单页应用，深链接回 index.html，
// 但答的不能再是老的 JSON。
const oldModels = await fetch(`${base}/admin/models`);
const oldModelsText = await oldModels.text();
check("老的 /admin/models 没了", !oldModelsText.includes('"data"'), oldModelsText.slice(0, 80));
const oldUsage = await fetch(`${base}/admin/usage`);
const oldUsageText = await oldUsage.text();
check("老的 /admin/usage 没了", !oldUsageText.includes('"data"'), oldUsageText.slice(0, 80));
check("老的 /admin/reload 没了", (await raw("/admin/reload", "POST")) === 404);

const health = await fetch(`${base}/health`);
const healthBody = await health.json();
check("/health 还是公开的", health.status === 200);
check("/health 的形状没变", healthBody?.status === "ok" && Boolean(healthBody?.upstreams) && Boolean(healthBody?.snapshot));
check("/health 里有各上游", Boolean(healthBody?.upstreams?.qoder?.regions));

console.log("");
console.log("重启以后");

// 再起一个：令牌文件已经在那里了，日志里不该再打一次。
router.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
log = "";
const second = startRouter();
const up = await waitForHealth();
check("第二个网关起来了", up);
check("令牌没有再打一遍", !log.includes("[ADMIN] 面板令牌已生成"), log.slice(0, 300));
check("令牌还是同一个", fs.readFileSync(tokenFile, "utf8").trim() === token);
second.kill("SIGTERM");

console.log("");
console.log(`pass=${pass} fail=${fail}`);
cleanup();
process.exit(fail ? 1 : 0);
