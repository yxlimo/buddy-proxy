// test/panel-e2e-check.ts — 面板上的那几处，在真浏览器里点一遍。
//
//   node --experimental-strip-types test/panel-e2e-check.ts
//
// 起一个真网关（test/harness.ts，随机端口，临时数据目录）+ agent-browser 打开
// `/admin/`，用数据目录里的 admin-token 进面板。数据全用面板那条接口（Connect）
// 铺出来：一个 openai 方言的平台，行里 12 个模型，一个开着的账号。
//
// 覆盖：
//   1. 「自定义模型」的下拉是完整列表：条数等于 ListModels 的条数，最后一条能选。
//   2. 只改一条：选一条、改显示名、保存 → 库里只多这一条人工元数据，平台行的
//      模型清单没变，再打开那条带「已改」。
//   3. 没改动不发请求：打开就关，保存灰着、旁边说「没有改动」，网关日志里没有
//      一次「人工模型元数据」的写入。
//   4. 能点出来的错误提前挡住：新建平台填一个已存在的 id → 保存灰着、行内说
//      「这个平台 id 已经被占用」、点不动，没有发请求。
//   5. 模拟客户端的编辑弹窗里没有「自动拉模型目录」开关，也没有可编辑的目录。
//   6. 「刷新模型目录」只看平台自己那一格：opencode-go 有，qiniu 没有。
//
// 离线：平台与目录都是本机铺的，不发任何真请求。
//
// 面板要构建过（web/dist/index.html）。没构建或者机子上没有 agent-browser 时
// 允许跳过：SKIP_BROWSER=1；REQUIRE_BROWSER=1 优先，跳过了就算失败。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "./harness.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function section(name: string): void {
  console.log("");
  console.log(name);
}

/* ------------------------------------------------------------------ *
 * 面板要构建过，机子上还要有 agent-browser
 * ------------------------------------------------------------------ */

const panelBuilt = fs.existsSync(path.join(ROOT, "web/dist/index.html"));
const browserSkipped = process.env.SKIP_BROWSER === "1";

if (!panelBuilt || browserSkipped) {
  const why = browserSkipped
    ? "SKIP_BROWSER=1，面板这一段跳过了（要跑它就别设这个变量）。"
    : "面板没构建（web/dist/index.html 不在）。先 cd web && pnpm build。";
  if (process.env.REQUIRE_BROWSER === "1") {
    check("面板这一段跑了", false, why);
    console.log("");
    console.log(`pass=${pass} fail=${fail}`);
    process.exit(1);
  }
  console.log(`--  ${why} 这一段没跑。`);
  console.log("");
  console.log("pass=0 fail=0（跳过）");
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 网关与面板
 * ------------------------------------------------------------------ */

const gw = await startGateway({});
const token = fs.readFileSync(path.join(gw.dataDir, "admin-token"), "utf8").trim();
const SESSION = `panel-e2e-${process.pid}`;

/** 铺数据用的那个平台：一个 openai 方言的开放平台，行里 12 个模型。 */
const PLATFORM = "opencode-go";
const MODEL_COUNT = 12;
const CATALOG = Array.from({ length: MODEL_COUNT }, (_, at) => `panel-model-${String(at + 1).padStart(2, "0")}`);
/** 改的那一条：列表里最后一个 —— 「能选到最后一条」与「只改一条」都落在它身上。 */
const TARGET = CATALOG[CATALOG.length - 1];
const NEW_NAME = "面板改过的名字";

async function rpc(method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}/buddy.admin.v1.AdminService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let reply: any;
  try {
    reply = JSON.parse(text);
  } catch {
    reply = { raw: text };
  }
  const code = res.headers.get("buddy-error");
  return { ...reply, httpStatus: res.status, ...(code ? { errorCode: code } : {}) };
}

/* ------------------------------------------------------------------ *
 * 跑一条 agent-browser 命令
 * ------------------------------------------------------------------ */

function runAb(args: string[], stdin?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("agent-browser", ["--session", SESSION, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.on("error", (e) => resolve({ code: 127, out: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, out }));
    child.stdin?.on("error", () => {
      /* 命令不吃 stdin 时写它会 EPIPE，不算失败 */
    });
    child.stdin?.end(stdin ?? "");
  });
}

/** 面板刷新的时候元素会短暂不在：多试几次。 */
async function ab(args: string[], times = 3, stdin?: string): Promise<{ code: number; out: string }> {
  let last = { code: 1, out: "" };
  for (let i = 0; i < times; i++) {
    last = await runAb(args, stdin);
    if (last.code === 0) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  return last;
}

/**
 * 在页面里跑一段 JS，拿回它 JSON.stringify 的那个值。
 *
 * agent-browser 把结果再包一层 JSON 字符串，所以解两次；解不开就是 undefined
 * （那一段脚本自己挂了）。
 */
async function evalJson(script: string): Promise<any> {
  const { out } = await ab(["eval", "--stdin"], 2, script);
  const line = out.trim().split("\n").filter((one) => one.trim() !== "").at(-1) ?? "";
  try {
    const value = JSON.parse(line);
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return undefined;
  }
}

/** 等页面上出现某段文字。 */
async function waitText(text: string): Promise<boolean> {
  const { code } = await ab(["wait", "--text", text], 3);
  return code === 0;
}

/* ------------------------------------------------------------------ *
 * 铺数据
 * ------------------------------------------------------------------ */

const madePlatform = await rpc("AddPlatform", {
  id: PLATFORM,
  label: "OpenCode Go",
  baseUrl: "https://panel.example.test/v1",
  kind: "openai",
});
check("P0 前提：建开放平台", madePlatform.platform?.id === PLATFORM && !madePlatform.errorCode, JSON.stringify(madePlatform).slice(0, 200));

const madeAccount = await rpc("AddAccount", { platform: PLATFORM, alias: "panel-e2e" });
check("P0 前提：加一个账号（目录要有开着的账号才公布）", !!madeAccount.id && !madeAccount.errorCode, JSON.stringify(madeAccount).slice(0, 200));

// 行里的模型清单：12 条手写目录。面板的「自定义模型」读的就是它 + 人工条目。
const setModels = await rpc("UpdatePlatform", {
  id: PLATFORM,
  label: "OpenCode Go",
  baseUrl: "https://panel.example.test/v1",
  models: CATALOG,
  modelsAuto: false,
});
check("P0 前提：行的模型清单 12 条", !setModels.errorCode && (setModels.platform?.models ?? []).length === MODEL_COUNT, JSON.stringify(setModels).slice(0, 240));

const catalogBefore = (await rpc("ListModels", { upstreamId: PLATFORM })).models ?? [];
check("P0 前提：ListModels 有 12 条", catalogBefore.length === MODEL_COUNT, `${catalogBefore.length} 条`);
const rowModelsBefore = JSON.stringify((await rpc("ListUpstreams", {})).upstreams?.find((one: any) => one.id === PLATFORM)?.models ?? null);

/** 网关日志里「人工模型元数据」写入的条数（读没有日志，写才有）。 */
function overrideWrites(): number {
  return gw.log().split("\n").filter((line) => line.includes("人工模型元数据")).length;
}

try {
  /* ---------------------------------------------------------------- *
   * 打开面板
   * ---------------------------------------------------------------- */

  section("P0 用令牌进面板");

  const opened = await ab(["open", `${gw.base}/admin/`], 2);
  check("P0 面板打开了", opened.code === 0, opened.out.slice(-200));
  check("P0 令牌闸门在", await waitText("输入访问令牌"), "没等到令牌输入框");
  await ab(["fill", "#admin-token", token], 2);
  const entered = await ab(["find", "role", "button", "click", "--name", "进入面板"], 2);
  check("P0 用令牌进得去", entered.code === 0, entered.out.slice(-200));
  check("P0 到了总览", await waitText("网关当前状态"), "没等到总览页");

  const upstreamsPage = await ab(["open", `${gw.base}/admin/upstreams`], 2);
  check("P0 平台页打开了", upstreamsPage.code === 0, upstreamsPage.out.slice(-200));
  check("P0 平台页的表在", await waitText("opencode-go"), "列表里没有 opencode-go");

  /* ---------------------------------------------------------------- *
   * P6 「刷新模型目录」只看平台自己那一格
   * ---------------------------------------------------------------- */

  section("P6 「刷新模型目录」只看平台自己那一格 modelsFromUpstream");

  /** 某一行的按钮文字。行按平台 id 认（卡片上就印着它）。 */
  const rowButtons = async (platformId: string): Promise<string[]> => {
    const got = await evalJson(`
      (() => {
        const rows = Array.from(document.querySelectorAll('tbody tr'));
        const row = rows.find((tr) => tr.textContent.includes(${JSON.stringify(platformId)}));
        if (!row) return JSON.stringify({ found: false, labels: [] });
        const labels = Array.from(row.querySelectorAll('button'))
          .map((b) => b.textContent.replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        return JSON.stringify({ found: true, labels });
      })()
    `);
    return Array.isArray(got?.labels) ? got.labels : [];
  };

  const opencodeButtons = await rowButtons(PLATFORM);
  check("P6 opencode-go 有「刷新模型目录」", opencodeButtons.includes("刷新模型目录"), opencodeButtons.join(" | "));
  const qiniuButtons = await rowButtons("qiniu");
  check("P6 qiniu 没有「刷新模型目录」", qiniuButtons.length > 0 && !qiniuButtons.includes("刷新模型目录"), qiniuButtons.join(" | "));
  const minimaxRowButtons = await rowButtons("minimax");
  check("P6 模拟客户端（minimax）也没有", minimaxRowButtons.length > 0 && !minimaxRowButtons.includes("刷新模型目录"), minimaxRowButtons.join(" | "));

  /* ---------------------------------------------------------------- *
   * P1 下拉是完整列表
   * ---------------------------------------------------------------- */

  section("P1 「自定义模型」的下拉是完整列表");

  /** 点某个平台那一行的某个按钮。 */
  const clickRowButton = async (platformId: string, label: string): Promise<boolean> => {
    const got = await evalJson(`
      (() => {
        const rows = Array.from(document.querySelectorAll('tbody tr'));
        const row = rows.find((tr) => tr.textContent.includes(${JSON.stringify(platformId)}));
        if (!row) return JSON.stringify({ clicked: false, why: 'no-row' });
        const button = Array.from(row.querySelectorAll('button'))
          .find((b) => b.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)});
        if (!button) return JSON.stringify({ clicked: false, why: 'no-button' });
        button.click();
        return JSON.stringify({ clicked: true });
      })()
    `);
    return got?.clicked === true;
  };

  check("P1 点开 opencode-go 的「自定义模型」", await clickRowButton(PLATFORM, "自定义模型"), "没找到那个按钮");
  check("P1 弹窗开了", await waitText(`自定义模型 · OpenCode Go`), "没等到弹窗标题");
  // 目录 + 人工条目都到手才摆格子。
  const listedCount = await evalJson(`
    (() => {
      const text = document.body.innerText;
      const hit = /共 (\\d+) 个模型/.exec(text);
      return JSON.stringify({ count: hit ? Number(hit[1]) : -1 });
    })()
  `);
  check(
    "P1 弹窗里说「共 N 个模型」，N 等于 ListModels 的条数",
    listedCount?.count === catalogBefore.length,
    `面板 ${listedCount?.count} / ListModels ${catalogBefore.length}`,
  );

  // 下拉里的条数：点开之后数 option。
  const openedSelect = await ab(["find", "role", "combobox", "click", "--name", "模型 id"], 3);
  check("P1 模型下拉点开了", openedSelect.code === 0, openedSelect.out.slice(-200));
  const optionCount = await evalJson(
    `(() => JSON.stringify({ count: document.querySelectorAll('[role="option"]').length }))()`,
  );
  check("P1 下拉里的条数等于 ListModels 的条数", optionCount?.count === catalogBefore.length, `下拉 ${optionCount?.count} / ListModels ${catalogBefore.length}`);
  const lastOption = await evalJson(`
    (() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const last = options[options.length - 1];
      return JSON.stringify({ text: last ? last.textContent.replace(/\\s+/g, ' ').trim() : '' });
    })()
  `);
  check("P1 下拉里最后一条是目录里的最后一个模型", String(lastOption?.text ?? "").includes(TARGET), String(lastOption?.text));

  // 选最后一条：它在弹窗里往下滚过的位置，点得到才算「列表是完整的」。
  const pickedLast = await ab(["find", "role", "option", "click", "--name", TARGET], 3);
  check("P1 能选到最后那一条", pickedLast.code === 0, pickedLast.out.slice(-200));
  const pickedText = await evalJson(`
    (() => {
      const trigger = document.querySelector('[aria-label="模型 id"]');
      return JSON.stringify({ value: trigger ? trigger.textContent.trim() : '' });
    })()
  `);
  check("P1 选中的就是最后那一条", String(pickedText?.value ?? "").includes(TARGET), String(pickedText?.value));

  /* ---------------------------------------------------------------- *
   * P2 只改一条
   * ---------------------------------------------------------------- */

  section("P2 只改一条：保存后库里只多这一条人工条目");

  const writesBeforeSave = overrideWrites();
  await ab(["fill", "#model-display-name", NEW_NAME], 2);
  const shownName = await evalJson(
    `(() => JSON.stringify({ value: document.querySelector('#model-display-name')?.value ?? '' }))()`,
  );
  check("P2 显示名填进去了", shownName?.value === NEW_NAME, String(shownName?.value));
  const saved = await ab(["find", "role", "button", "click", "--name", "保存"], 3);
  check("P2 保存点得到", saved.code === 0, saved.out.slice(-200));
  // 存完弹窗自己关：等到标题消失，不等一个固定时长。
  const closed = await ab(["wait", "--fn", "!document.body.innerText.includes('自定义模型 ·')"], 3);
  check("P2 保存完弹窗关了", closed.code === 0, closed.out.slice(-200));
  check("P2 真的发了一次写", overrideWrites() === writesBeforeSave + 1, `${writesBeforeSave} → ${overrideWrites()}`);

  const overridesAfter = (await rpc("ListModelOverrides", { platformId: PLATFORM })).overrides ?? [];
  check("P2 库里只有这一条人工元数据", overridesAfter.length === 1 && overridesAfter[0]?.id === TARGET, JSON.stringify(overridesAfter).slice(0, 240));
  check("P2 写的是改了的那个显示名", overridesAfter[0]?.displayName === NEW_NAME, JSON.stringify(overridesAfter[0] ?? {}).slice(0, 240));
  const catalogAfter = (await rpc("ListModels", { upstreamId: PLATFORM })).models ?? [];
  check("P2 目录条数不变", catalogAfter.length === catalogBefore.length, `${catalogAfter.length} / ${catalogBefore.length}`);
  check("P2 ListModels 里那条的显示名变了", catalogAfter.find((m: any) => m.id === TARGET)?.displayName === NEW_NAME, String(catalogAfter.find((m: any) => m.id === TARGET)?.displayName));
  const rowModelsAfter = JSON.stringify((await rpc("ListUpstreams", {})).upstreams?.find((one: any) => one.id === PLATFORM)?.models ?? null);
  check("P2 平台行的模型清单没变", rowModelsAfter === rowModelsBefore, `${rowModelsBefore.slice(0, 120)} / ${rowModelsAfter.slice(0, 120)}`);

  // 再打开一次：那条带「已改」，条数仍是目录 + 人工那一条（不重复）。
  check("P2 再打开「自定义模型」", await clickRowButton(PLATFORM, "自定义模型"), "没找到那个按钮");
  check("P2 弹窗又开了", await waitText(`自定义模型 · OpenCode Go`), "没等到弹窗标题");
  const reopened = await evalJson(`
    (() => {
      const trigger = document.querySelector('[aria-label="模型 id"]');
      const text = document.body.innerText;
      const hit = /共 (\\d+) 个模型/.exec(text);
      return JSON.stringify({ count: hit ? Number(hit[1]) : -1, value: trigger ? trigger.textContent.trim() : '' });
    })()
  `);
  check("P2 共 N 个模型：人工那条不另算一条", reopened?.count === catalogAfter.length, `面板 ${reopened?.count} / ListModels ${catalogAfter.length}`);
  const marked = await ab(["find", "role", "combobox", "click", "--name", "模型 id"], 3);
  check("P2 下拉点开了", marked.code === 0, marked.out.slice(-200));
  const changedBadge = await evalJson(`
    (() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const hit = options.find((o) => o.textContent.includes(${JSON.stringify(TARGET)}));
      return JSON.stringify({ text: hit ? hit.textContent.replace(/\\s+/g, ' ').trim() : '' });
    })()
  `);
  check("P2 人工改过的那条标着「已改」", String(changedBadge?.text ?? "").includes("已改"), String(changedBadge?.text));
  // 再把它选回来：弹窗里的显示名应是库里存的那一份（人工元数据真的读回来了）。
  const backToTarget = await ab(["find", "role", "option", "click", "--name", TARGET], 3);
  check("P2 能把那条再选回来", backToTarget.code === 0, backToTarget.out.slice(-200));
  const reloadedName = await evalJson(
    `(() => JSON.stringify({ value: document.querySelector('#model-display-name')?.value ?? '' }))()`,
  );
  check("P2 再打开时显示名是库里存的那一份", reloadedName?.value === NEW_NAME, String(reloadedName?.value));
  // 关掉弹窗。
  await ab(["find", "role", "button", "click", "--name", "取消"], 2);

  /* ---------------------------------------------------------------- *
   * P3 没改动不发请求
   * ---------------------------------------------------------------- */

  section("P3 没改动不发请求");

  const writesBeforeNoop = overrideWrites();
  check("P3 再打开「自定义模型」", await clickRowButton(PLATFORM, "自定义模型"), "没找到那个按钮");
  check("P3 弹窗开了", await waitText(`自定义模型 · OpenCode Go`), "没等到弹窗标题");
  const idle = await evalJson(`
    (() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent.trim() === '保存');
      return JSON.stringify({
        disabled: button ? button.disabled : null,
        hint: document.body.innerText.includes('没有改动'),
      });
    })()
  `);
  check("P3 一格没改时保存是灰的", idle?.disabled === true, String(idle?.disabled));
  check("P3 旁边说「没有改动」", idle?.hint === true, String(idle?.hint));
  await ab(["find", "role", "button", "click", "--name", "取消"], 2);
  // 关掉之后不该有写请求。
  await new Promise((r) => setTimeout(r, 500));
  check("P3 打开就关：一次写请求都没有", overrideWrites() === writesBeforeNoop, `${writesBeforeNoop} → ${overrideWrites()}`);

  /* ---------------------------------------------------------------- *
   * P4 能点出来的错误提前挡住
   * ---------------------------------------------------------------- */

  section("P4 重复的平台 id：保存灰着、行内说清、点不动");

  const platformsBefore = ((await rpc("ListUpstreams", {})).upstreams ?? []).length;
  const expandedBefore = gw.log().split("\n").filter((line) => line.includes("开放平台")).length;
  const addClicked = await ab(["find", "role", "button", "click", "--name", "新增平台"], 3);
  check("P4 打开「新增平台」", addClicked.code === 0, addClicked.out.slice(-200));
  // 弹窗的判据用它自己的描述句：页面上的「新增平台」按钮也叫这个字，等文字会误判。
  check("P4 弹窗开了", await waitText("先建一个空平台"), "没等到弹窗的描述句");
  await ab(["fill", "#platform-id", "qiniu"], 2);
  await ab(["fill", "#platform-label", "重复的"], 2);
  await ab(["fill", "#platform-base-url", "https://dup.example.test/v1"], 2);
  const dup = await evalJson(`
    (() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent.trim() === '加上');
      return JSON.stringify({
        disabled: button ? button.disabled : null,
        taken: document.body.innerText.includes('这个平台 id 已经被占用'),
      });
    })()
  `);
  check("P4 行内说「这个平台 id 已经被占用」", dup?.taken === true, String(dup?.taken));
  check("P4 保存（加上）是灰的", dup?.disabled === true, String(dup?.disabled));
  // 灰着也点一下（真指针）：不发请求，也不报错。
  //
  // 不断「弹窗还开着」：按钮 disabled 时浏览器不给它派发鼠标事件，自动化的
  // pointerdown 会落到底下，Radix 把那一层当「点了外面」把弹窗关上 —— 那是
  // 自动化打出来的，不是用户能碰到的东西。能断言的是「什么也没发生」：
  // 没有报错、平台数量不变、日志里没有建平台那一单。
  const alertsBefore = await evalJson(`(() => JSON.stringify({ alerts: document.querySelectorAll('[role="alert"]').length }))()`);
  await ab(["find", "role", "button", "click", "--name", "加上"], 2);
  await new Promise((r) => setTimeout(r, 400));
  const alertsAfter = await evalJson(`(() => JSON.stringify({ alerts: document.querySelectorAll('[role="alert"]').length }))()`);
  check("P4 点了一下也没冒出错误提示", (alertsAfter?.alerts ?? 0) <= (alertsBefore?.alerts ?? 0), `${alertsBefore?.alerts} → ${alertsAfter?.alerts}`);
  check(
    "P4 平台数量没变（没有发出建平台那一单）",
    ((await rpc("ListUpstreams", {})).upstreams ?? []).length === platformsBefore,
    `${platformsBefore} → ${((await rpc("ListUpstreams", {})).upstreams ?? []).length}`,
  );
  check(
    "P4 网关日志里没有一次「开放平台 ... 改了」或建平台的写入",
    gw.log().split("\n").filter((line) => line.includes("开放平台")).length === expandedBefore,
    `${expandedBefore} → ${gw.log().split("\n").filter((line) => line.includes("开放平台")).length}`,
  );
  await ab(["find", "role", "button", "click", "--name", "取消"], 2);

  /* ---------------------------------------------------------------- *
   * P5 模拟客户端的编辑弹窗
   * ---------------------------------------------------------------- */

  section("P5 模拟客户端：编辑弹窗里没有目录那两格");

  check("P5 点开 minimax 的「编辑」", await clickRowButton("minimax", "编辑"), "没找到那个按钮");
  check("P5 弹窗开了", await waitText("改平台 MiniMax Code"), "没等到弹窗标题");
  const simulatedDialog = await evalJson(`
    (() => {
      const text = document.body.innerText;
      return JSON.stringify({
        autoSwitch: Boolean(document.querySelector('[role="switch"][aria-label="自动拉模型目录"]')),
        modelsTextarea: Boolean(document.querySelector('#platform-models')),
        line: text.includes('模型目录由代码提供，不能改。'),
        label: Boolean(document.querySelector('#platform-label')),
      });
    })()
  `);
  check("P5 没有「自动拉模型目录」开关", simulatedDialog?.autoSwitch === false, String(simulatedDialog?.autoSwitch));
  check("P5 没有可编辑的模型目录", simulatedDialog?.modelsTextarea === false, String(simulatedDialog?.modelsTextarea));
  check("P5 说清了目录归代码", simulatedDialog?.line === true, String(simulatedDialog?.line));
  check("P5 名字那一格还在（改名照常能改）", simulatedDialog?.label === true, String(simulatedDialog?.label));
  await ab(["find", "role", "button", "click", "--name", "取消"], 2);
} finally {
  await ab(["close"], 2);
  gw.stop();
  fs.rmSync(gw.dataDir, { recursive: true, force: true });
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log("");
  console.log("失败：");
  for (const one of problems) console.log(`  - ${one}`);
}
process.exit(fail === 0 ? 0 : 1);
