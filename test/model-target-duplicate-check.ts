// test/model-target-duplicate-check.ts — 主路由模型的目标不许重复；500 必须留痕。
//
//   node --experimental-strip-types test/model-target-duplicate-check.ts
//
// 离线：假上游一个都不碰（本文件连网关都不必起 —— 落库的那部分在进程内做）。
//
// 三件事：
//
//   1. 同一个（平台，上游模型）在一次保存里出现两次 → 挡住，给一句说清哪一
//      对重了的话。以前它一路走到写库，撞 aggregate_target 的主键，SQLite 抛
//      约束错误，冒到面板那里是 500 加一句 internal error（面板只显示「保存
//      失败」）。
//   2. 同一平台的不同上游模型（正常的 fallback）不许被拦。
//   3. 出了意外的错，日志里要留得下痕迹 —— Connect 自己把实现抛的异常换成
//      一句 "internal error"，不留日志的话那次 500 查不动。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/* ------------------------------------------------------------------ *
 * 准备
 * ------------------------------------------------------------------ */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "model-target-duplicate-"));
// 数据目录要在导入库模块之前定下来：store 是进程里的单例。
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { savePublishedModel, publishedModels } = await import("../lib/admin/models.ts");
const { traceUnexpected } = await import("../lib/admin/http.ts");
const { ADMIN_ERROR_HEADER } = await import("../lib/admin/error-codes.ts");
const { Code, ConnectError } = await import("@connectrpc/connect");

/** 面板发来的一份目标：平台 + 上游模型 + 权重。 */
function target(groupName: string, upstreamModel: string, weight: number) {
  return { groupName, upstreamModel, weight, enabled: true };
}

/** 一次保存的结果（只留要断言的那几格）。 */
function save(id: string, targets: ReturnType<typeof target>[]) {
  const result = savePublishedModel({
    id,
    displayName: id,
    enabled: true,
    strategy: "fallback",
    effortOptions: [],
    targets,
  });
  return result;
}

/* ------------------------------------------------------------------ *
 * 一、重复的目标：挡住并说清哪一对
 * ------------------------------------------------------------------ */

section("重复的目标");

const dup = save("dup-target-model", [
  target("tokenrhythm", "glm-5.3-flash", 50),
  target("workbuddy-cn", "glm-5.3-flash", 60),
  target("sensenova", "sensenova-6.8-flash", 25),
  target("intern-ai", "Atria-Dawn-Preview", 24),
  target("tokenrhythm", "glm-5.3-flash", 1),
]);
check("重复的目标不收", dup.ok === false, JSON.stringify(dup));
check("重复的目标有机器码", (dup as { code?: string }).code === "MODEL_DUPLICATE_TARGET", String((dup as { code?: string }).code));
check(
  "机器码说的是哪一对重了",
  String((dup as { message?: string }).message ?? "").includes("tokenrhythm/glm-5.3-flash"),
  String((dup as { message?: string }).message ?? ""),
);
check("重复的目标没有被存进去", !publishedModels().some((m) => m.id === "dup-target-model"));

section("权重不同也是同一对");

// 同一对给两个权重：还是同一对，落库照样撞主键。
const dupWeights = save("dup-weight-model", [
  target("tokenrhythm", "glm-5.3-flash", 50),
  target("tokenrhythm", "glm-5.3-flash", 1),
]);
check("权重不同的同一对也不收", dupWeights.ok === false, JSON.stringify(dupWeights));
check(
  "机器码还是那一个",
  (dupWeights as { code?: string }).code === "MODEL_DUPLICATE_TARGET",
  String((dupWeights as { code?: string }).code),
);

section("同一平台的不同上游模型：正常的 fallback");

const fallback = save("fallback-model", [
  target("tokenrhythm", "glm-5.3-flash", 50),
  target("tokenrhythm", "neohorse-1-9b", 60),
]);
check("不同上游模型存得进去", fallback.ok === true, JSON.stringify(fallback));
const saved = publishedModels().find((m) => m.id === "fallback-model");
check("两个目标都在", saved?.targets.length === 2, String(saved?.targets.length));
check(
  "两个目标说的都是 tokenrhythm",
  saved?.targets.every((t) => t.groupName === "tokenrhythm") === true,
  saved?.targets.map((t) => `${t.groupName}/${t.upstreamModel}`).join(","),
);

/* ------------------------------------------------------------------ *
 * 二、未预期的错要留痕
 * ------------------------------------------------------------------ */

section("500 留痕");

// Connect 自己接住实现抛的异常，换成一句 "internal error" 的 500 —— 栈就没了。
// 留痕的那一层在实现与 Connect 之间：它把栈打出来，再原样抛回去。
const realError = console.error;

/** 跑一次拦截器，把这段时间 console.error 打出来的行收下来。 */
async function loggedFrom(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(" "));
  };
  try {
    await run();
  } catch {
    /* 意料之中：它原样抛回来了 */
  } finally {
    console.error = realError;
  }
  return lines;
}

/** 拿给定的 url 跑一次拦截器，实现里抛 err。 */
function logFor(url: string, err: unknown): Promise<string[]> {
  return loggedFrom(() =>
    traceUnexpected(async () => {
      throw err;
    })({ url } as never),
  );
}

const logged = await logFor("/buddy.admin.v1.AdminService/SavePublishedModel", new Error("boom from the implementation"));
check(
  "未预期的错打了方法路径",
  logged.some((line) => line.includes("/buddy.admin.v1.AdminService/SavePublishedModel")),
  logged.join(" | ").slice(0, 200),
);
check(
  "未预期的错打了栈",
  logged.some((line) => line.includes("boom from the implementation")),
  logged.join(" | ").slice(0, 200),
);

// Connect 交给拦截器的 url 是绝对的 —— authority 来自请求的 Host 头。整条打
// 出去，内网主机名就进了容器日志，而日志会被复制、归档、发到别处。只留路径
// （query 也不留：那里面只有 connect 的协议参数）。
const HOST = "admin-host.invalid:6450";
const withHost = await logFor(
  `http://${HOST}/buddy.admin.v1.AdminService/SavePublishedModel?connect=v1&encoding=json`,
  new Error("boom behind a Host header"),
);
check(
  "带 Host 的请求打了方法路径",
  withHost.some((line) => line.includes("/buddy.admin.v1.AdminService/SavePublishedModel")),
  withHost.join(" | ").slice(0, 200),
);
check(
  "带 Host 的请求没打主机名",
  withHost.length > 0 && withHost.every((line) => !line.includes("admin-host.invalid")),
  withHost.join(" | ").slice(0, 200),
);

// 上游的正文片段会被原样塞进 error message（sensenova/models.ts、intern-ai/
// models.ts），而上游 401 的正文里回显的就是 key 片段 —— 栈里带着 message，
// 进日志之前得抹一遍。
const TOKEN = "sk-TESTONLY0000000000"; // privacy:allow — 编造的样例
const scrubbed = await logFor(
  "/buddy.admin.v1.AdminService/SavePublishedModel",
  new Error(`upstream rejected key ${TOKEN}`),
);
check(
  "错误 message 里的令牌被抹掉",
  scrubbed.length > 0 && scrubbed.every((line) => !line.includes(TOKEN)),
  scrubbed.join(" | ").slice(0, 300),
);
check(
  "抹过之后那句话还读得懂",
  scrubbed.some((line) => line.includes("upstream rejected key")),
  scrubbed.join(" | ").slice(0, 300),
);

// 面板自己问出来的失败（带机器码）不是意外：服务方法那边已经写过日志了，
// 这里再打一遍栈只是噪音 —— 每个校验失败（400）都刷一条栈的话，日志就没法
// 看了。判据就在拦截器里（且只在拦截器里）：handleConnect 那一层的 catch 早
// 就删了，实现异常走不到那儿 —— handler-factory 自己吃成 500。
const askedLogged = await logFor(
  "/buddy.admin.v1.AdminService/SavePublishedModel",
  new ConnectError("model id is empty", Code.InvalidArgument, {
    [ADMIN_ERROR_HEADER]: "MODEL_ID_MISSING",
  }),
);
check(
  "带机器码的失败一条 [ADMIN] 都不打",
  askedLogged.every((line) => !line.includes("[ADMIN]")),
  askedLogged.join(" | ").slice(0, 200),
);

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

section("结果");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  console.log("查出来的问题：");
  for (const problem of problems) console.log(`  - ${problem}`);
}
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
