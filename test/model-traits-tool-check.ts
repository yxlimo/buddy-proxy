// test/model-traits-tool-check.ts — scripts/model-traits.ts：从上游实拉参数并进共性表。
//
//   mise run test:model-traits:tool
//   node --experimental-strip-types test/model-traits-tool-check.ts
//
// 离线：一个假上游（本机 http），一个临时 BUDDY_DATA_DIR（库里只有三个假平台），
// 不发真请求、不花额度、不碰仓库里那张表 —— 每一轮都写临时目录里的一份。
//
// 这个工具的风险不在「拉不到」，在「把人对的值改掉」与「同一份输入写出两份不同的
// 文件」。所以这里逐条测的就是那几条语义：
//
//   1. 空表 + 上游给参数 → 新增条目，字段正确
//   2. 表里人工写过的值不被覆盖，但空着的字段被补上
//   3. 上游只给 id → 条目没有参数键（不写 0 / false）
//   4. 输出确定：同输入两次逐字节相同、换个报的顺序也一样；--check 0 / 1
//   5. 404 与超时 → 跳过这一家、说清原因、其余照常合并、退出码不是 1
//   6. 输出里没有令牌、没有绝对路径

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "model-traits.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model-traits-tool-"));

// 库的位置在**第一次** store() 之前就得定下来：这个进程之后打开的每个模块都用它
const dataDir = path.join(tmp, "data");
process.env.BUDDY_DATA_DIR = dataDir;

// 编造的样例：被测的就是「令牌不出现在输出里」，所以这一行必须存在
const TOKEN = "sk-TESTONLY0000000000000000"; // privacy:allow — 编造的样例

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

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

/** `/a` 的答复。测试中途换它，模拟上游改了参数或者换了一批模型。 */
let payloadA: unknown = { data: [] };
/** `/a` 收到过的鉴权头：顺带确认 key 真的发出去了（发出去不等于要打印出来）。 */
const authSeen: string[] = [];

const fake = http.createServer((req, res) => {
  const url = req.url ?? "";
  authSeen.push(String(req.headers.authorization ?? ""));
  if (url.startsWith("/a/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payloadA));
    return;
  }
  if (url.startsWith("/slow/models")) {
    // 不应答：这一家就是「上游不说话」，脚本按超时跳过
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const port = (fake.address() as { port: number }).port;

/* ------------------------------------------------------------------ *
 * 临时的库：三个平台，一个答得好、一个 404、一个不答
 * ------------------------------------------------------------------ */

const { store, setSecret } = await import("../lib/store.ts");
const db = store();

function addPlatform(id: string, pathname: string, accountId: string): void {
  db.prepare(
    "INSERT INTO platform (id, label, base_url, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, id, `http://127.0.0.1:${port}${pathname}`, "openai", 0, 0);
  db.prepare(
    "INSERT INTO provider (id, platform, alias, enabled, weight, created_at, updated_at) VALUES (?, ?, ?, 1, 100, 0, 0)",
  ).run(accountId, id, id);
  setSecret(`key:provider:${accountId}:key`, "key", { apiKey: TOKEN });
}

addPlatform("up-a", "/a", "1");
addPlatform("up-b", "/b", "2");
addPlatform("up-c", "/slow", "3");

const { run, fetchTraits, displayPath, DEFAULT_TABLE } = await import("../scripts/model-traits.ts");

/** 一份表写成文件：`{}` 就是空表。 */
function writeTable(file: string, models: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, "utf8");
}

function readTable(file: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(file, "utf8")).models;
}

/**
 * 跑一次命令行，返回退出码与全部输出。
 *
 * 异步，不是 spawnSync：假上游就活在这个进程里，同步等待会把事件循环堵住 —— 子
 * 进程那一次请求拿不到答复，于是每一次都「超时」，测的就不是脚本了。
 */
async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, BUDDY_DATA_DIR: dataDir },
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    out += String(chunk);
  });
  const code = await new Promise<number>((resolve) => child.on("close", (value) => resolve(value ?? -1)));
  return { code, out };
}

console.log("");
console.log("1. 空表 + 上游给了参数 → 新增条目");

const one = path.join(tmp, "t1.json");
writeTable(one, {});
payloadA = {
  data: [
    { id: "deepseek-v4-flash", context_length: 200000, max_tokens: 65536 },
    // 星火的压缩写法：归一化后原样进表，不在这里做近似匹配
    { id: "xopdeepseekv4flash0731", context_length: 1000000 },
  ],
};
const first = await cli(["--table", one, "--platform", "up-a"]);
const oneTable = readTable(one);
check("退出 0", first.code === 0, `${first.code} ${first.out.slice(0, 200)}`);
check("上游的 context_length 成了 contextWindow", oneTable["deepseek-v4-flash"]?.contextWindow === 200000, JSON.stringify(oneTable["deepseek-v4-flash"]));
check("上游的 max_tokens 成了 maxOutputTokens", oneTable["deepseek-v4-flash"]?.maxOutputTokens === 65536, JSON.stringify(oneTable["deepseek-v4-flash"]));
check("来源是这家平台", JSON.stringify(oneTable["deepseek-v4-flash"]?.sources) === '["up-a"]', JSON.stringify(oneTable["deepseek-v4-flash"]?.sources));
check(
  "压缩写法归一化后进表",
  oneTable["xopdeepseekv4flash"]?.contextWindow === 1000000 && !("xopdeepseekv4flash0731" in oneTable),
  Object.keys(oneTable).join(","),
);
check("差异里说新增了哪几个字段", first.out.includes("新增 deepseek-v4-flash：contextWindow, maxOutputTokens"), first.out.split("\n").filter((l) => l.startsWith("新增")).join(" | "));

console.log("");
console.log("2. 人工写过的值不覆盖，空着的字段补上");

const two = path.join(tmp, "t2.json");
writeTable(two, { "deepseek-v4-flash": { contextWindow: 123, sources: ["measured"] } });
payloadA = { data: [{ id: "deepseek-v4-flash", context_length: 999999, max_output_tokens: 4096 }] };
const second = await cli(["--table", two, "--platform", "up-a"]);
const twoTable = readTable(two);
check(
  "人工写的 contextWindow 留着",
  twoTable["deepseek-v4-flash"]?.contextWindow === 123,
  JSON.stringify(twoTable["deepseek-v4-flash"]),
);
check(
  "上游独有的 maxOutputTokens 补上了",
  twoTable["deepseek-v4-flash"]?.maxOutputTokens === 4096,
  JSON.stringify(twoTable["deepseek-v4-flash"]),
);
check(
  "来源追加平台 id 并排序",
  JSON.stringify(twoTable["deepseek-v4-flash"]?.sources) === '["measured","up-a"]',
  JSON.stringify(twoTable["deepseek-v4-flash"]?.sources),
);
check(
  "差异里只说补了哪一格，不说改了什么",
  second.out.includes("deepseek-v4-flash maxOutputTokens: 缺 → 4096") && !second.out.includes("999999"),
  second.out.split("\n").filter((l) => l.startsWith("deepseek-v4-flash")).join(" | "),
);

console.log("");
console.log("3. 上游只给 id → 条目没有参数键");

const three = path.join(tmp, "t3.json");
writeTable(three, {});
payloadA = { data: [{ id: "glm-5-2" }] };
await cli(["--table", three, "--platform", "up-a"]);
const threeTable = readTable(three);
check("条目出现了", "glm-5-2" in threeTable, Object.keys(threeTable).join(","));
check(
  "除了来源什么都没有（不写 0 / false / 空数组）",
  JSON.stringify(threeTable["glm-5-2"]) === '{"sources":["up-a"]}',
  JSON.stringify(threeTable["glm-5-2"]),
);

console.log("");
console.log("4. 输出确定，--check 说得出不一致");

const four = path.join(tmp, "t4.json");
writeTable(four, {});
payloadA = { data: [{ id: "zz-last", context_length: 1000 }, { id: "aa-first", max_output_tokens: 10 }] };
const run1 = await cli(["--table", four, "--platform", "up-a"]);
const bytes1 = fs.readFileSync(four, "utf8");
check("第一次跑就有东西写进去", run1.code === 0 && bytes1.includes('"zz-last"'), `${run1.code}`);
const run2 = await cli(["--table", four, "--platform", "up-a"]);
const bytes2 = fs.readFileSync(four, "utf8");
check("两次跑出来逐字节相同", bytes1 === bytes2, `${bytes1.length} / ${bytes2.length}`);
check("第二次没有差异可说", !run2.out.includes("新增") && !run2.out.includes("缺 →"), run2.out.split("\n").slice(-4).join(" | "));
check("键按字母序", Object.keys(readTable(four)).join(",") === "aa-first,zz-last", Object.keys(readTable(four)).join(","));
check("没有时间戳", !/\d{4}-\d{2}-\d{2}T/.test(bytes1), "");

// 上游把同一批模型换个顺序报：结果必须还是同一份文件。少了排序这条就会红。
const fourB = path.join(tmp, "t4b.json");
writeTable(fourB, {});
payloadA = { data: [{ id: "aa-first", max_output_tokens: 10 }, { id: "zz-last", context_length: 1000 }] };
await cli(["--table", fourB, "--platform", "up-a"]);
check("上游报的顺序不影响输出", fs.readFileSync(fourB, "utf8") === bytes1, "");

// 手写的表键是倒序的：跑一遍之后也排好，所以 --check 对它说过期是对的
const fourC = path.join(tmp, "t4c.json");
writeTable(fourC, {
  "zz-last": { contextWindow: 1000, sources: ["up-a"] },
  "aa-first": { maxOutputTokens: 10, sources: ["up-a"] },
});
const reversed = await cli(["--table", fourC, "--platform", "up-a", "--check"]);
check("手工写的倒序表也算过期", reversed.code === 1, `${reversed.code}`);

const clean = await cli(["--table", four, "--platform", "up-a", "--check"]);
check("--check 在一致时退出 0", clean.code === 0, `${clean.code} ${clean.out.slice(0, 200)}`);
check("并说表没变", clean.out.includes("表没变"), clean.out.slice(-120));

// 有人手改表把补上的那格删了（等于表过期了）：--check 必须红
const fourEdit = JSON.parse(fs.readFileSync(four, "utf8"));
delete fourEdit.models["zz-last"].contextWindow;
fs.writeFileSync(four, `${JSON.stringify(fourEdit, null, 2)}\n`, "utf8");
const stale = await cli(["--table", four, "--platform", "up-a", "--check"]);
check("--check 在表被改过时退出 1", stale.code === 1, `${stale.code} ${stale.out.slice(0, 200)}`);
check("并说要重新生成", stale.out.includes("需要重新生成"), stale.out.slice(-160));

console.log("");
console.log("5. 拉不到不是差异：404 与超时都跳过这一家");

const five = path.join(tmp, "t5.json");
writeTable(five, {});
payloadA = { data: [{ id: "kimi-k3", context_length: 256000 }] };
const mixed = await cli(["--table", five, "--platform", "up-a", "--platform", "up-b"]);
check("退出码不是 1", mixed.code === 0, `${mixed.code}`);
check("404 那家说清了原因", mixed.out.includes("跳过 up-b：HTTP 404"), mixed.out.split("\n").filter((l) => l.includes("up-b")).join(" | "));
check("答得好的那家照常合并", readTable(five)["kimi-k3"]?.contextWindow === 256000, JSON.stringify(readTable(five)));

// 超时：同一个 run() 里一家不说话、一家正常，退出码仍然是 0
const fiveB = path.join(tmp, "t5b.json");
writeTable(fiveB, {});
const said: string[] = [];
const savedLog = console.log;
let timeoutCode = -1;
try {
  console.log = (...args: unknown[]) => said.push(args.map(String).join(" "));
  timeoutCode = await run({
    table: fiveB,
    sources: [
      { id: "up-c", baseUrl: `http://127.0.0.1:${port}/slow`, kind: "openai", apiKey: TOKEN },
      { id: "up-a", baseUrl: `http://127.0.0.1:${port}/a`, kind: "openai", apiKey: TOKEN },
    ],
    timeoutMs: 200,
  });
} finally {
  console.log = savedLog;
}
const saidText = said.join("\n");
check("超时不改变退出码", timeoutCode === 0, String(timeoutCode));
check("超时那家说清了原因", saidText.includes("跳过 up-c：超时"), saidText.split("\n").filter((l) => l.includes("up-c")).join(" | "));
check("另一家照常合并", readTable(fiveB)["kimi-k3"]?.contextWindow === 256000, Object.keys(readTable(fiveB)).join(","));

// 单测一次 fetchTraits：超时返回的是一句原因，不是一个空清单
const slow = await fetchTraits(
  { id: "up-c", baseUrl: `http://127.0.0.1:${port}/slow`, kind: "openai", apiKey: TOKEN },
  150,
);
check("fetchTraits 超时说超时", slow.ok === false && slow.reason === "超时", JSON.stringify(slow));

// 一家都不通的时候退出码还是 0：都没问到，表没有变化可说
const fiveC = path.join(tmp, "t5c.json");
writeTable(fiveC, {});
const dead = await cli(["--table", fiveC, "--platform", "up-b"]);
check("全都不通也退出 0", dead.code === 0, `${dead.code}`);
check("并说明表保持原样", dead.out.includes("一家都没拉到"), dead.out.slice(-160));

console.log("");
console.log("6. 输出里没有令牌，也没有绝对路径");

// 不限定平台：所有推送进来的平台都过一遍（库里另外那几家种下来的平台没有 key，跳过）
const six = path.join(tmp, "deep", "t6.json");
writeTable(six, {});
payloadA = { data: [{ id: "glm-5-2", max_tokens: 4096 }] };
const beforeDry = fs.readFileSync(six, "utf8");
const wet = await cli(["--table", six, "--dry-run"]);
check(
  "--dry-run 不写文件",
  wet.code === 0 && fs.readFileSync(six, "utf8") === beforeDry && !wet.out.includes("写了"),
  String(wet.code),
);
check("令牌一次都没出现在输出里", !wet.out.includes(TOKEN), wet.out.split("\n").filter((l) => l.includes("sk-")).join(" | "));
check("没有本机绝对路径", !wet.out.includes(tmp) && !wet.out.includes(dataDir), wet.out.split("\n").filter((l) => l.includes("/tmp")).join(" | "));
check("没有上游地址", !wet.out.includes("127.0.0.1"), wet.out.split("\n").filter((l) => l.includes("127.0.0.1")).join(" | "));
check("--dry-run 会把要写的内容打出来", wet.out.includes('"glm-5-2"'), wet.out.slice(-200));
check(
  "键真的带上去发请求了（没打印不等于没发）",
  authSeen.some((header) => header === `Bearer ${TOKEN}`),
  `${authSeen.length} 次`,
);

// 表在仓库里时打印相对路径，别的地方只留文件名
check("仓库里的表打相对路径", displayPath(DEFAULT_TABLE) === path.join("lib", "model-traits.json"), displayPath(DEFAULT_TABLE));
check("别处的表只留文件名", displayPath(path.join(tmp, "deep", "t6.json")) === "t6.json", displayPath(path.join(tmp, "deep", "t6.json")));

console.log("");
console.log("7. 平台 id 不认识时是用法错误");

const unknown = await cli(["--table", one, "--platform", "no-such-platform"]);
check("退出 2", unknown.code === 2, `${unknown.code}`);
check("并说出是哪个 id", unknown.out.includes("没有这个平台：no-such-platform"), unknown.out.slice(0, 200));

fake.closeAllConnections();
await new Promise<void>((resolve) => fake.close(() => resolve()));
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
