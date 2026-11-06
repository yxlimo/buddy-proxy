// test/model-traits-check.ts — 共性表：数据本身，以及「按 id 找到它」。
//
//   mise run test:model-traits
//   node --experimental-strip-types test/model-traits-check.ts
//
// 离线：只读 lib/model-traits.json 与 lib/common-model-traits.ts，不发请求、不花额度。
//
// 这张表的价值全在「配得准」上：一条配错窗口的条目会被公布给所有客户端，而一个
// 查不到的 id 只是少一格参数。所以这里除了数据形状，重点测两件事：
//
//   - 近似的边界：星火的压缩 id 要能接到表里的标准写法（`xopglm51` → `glm-5-1`）
//   - 数字是身份：`deepseek-v4-flash` 绝不许接到 `deepseek-v4.1-flash` 上；两个
//     候选都像的时候按没有处理，不猜

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commonTraitsOf, lookupModelId, normalizeModelId } from "../lib/common-model-traits.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "..", "lib", "model-traits.json");

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

const text = fs.readFileSync(FILE, "utf8");
const raw: unknown = JSON.parse(text);
const doc = raw as { version?: unknown; models?: unknown };
const models = (doc.models ?? {}) as Record<string, Record<string, unknown>>;
const keys = Object.keys(models);

console.log("");
console.log("文件能解析，形状是约定的那样");

check("it is a JSON object", !!raw && typeof raw === "object" && !Array.isArray(raw));
check("version is 1", doc.version === 1, JSON.stringify(doc.version));
check("models is an object with entries", keys.length > 0, JSON.stringify(keys.length));

// 允许写进一条的键。写错一个字段名（`context_window`）在这里就是一条错的数据，
// 而读取那一层会把它丢掉 —— 所以要在数据这一侧挡住。
const allowed = new Set([
  "contextWindow",
  "maxOutputTokens",
  "reasoning",
  "toolCall",
  "efforts",
  "defaultEffort",
  "credits",
  "sources",
]);
const unknownFields: string[] = [];
for (const key of keys) {
  for (const field of Object.keys(models[key] ?? {})) {
    if (!allowed.has(field)) unknownFields.push(`${key}.${field}`);
  }
}
check("every entry carries only the known fields", unknownFields.length === 0, unknownFields.join(", "));

// 「不知道」就是没有这个键：0、false、空数组都是断言，不是缺失。
const numbers = keys.flatMap((key) =>
  (["contextWindow", "maxOutputTokens"] as const)
    .filter((field) => field in (models[key] ?? {}))
    .map((field) => ({ id: key, field, value: models[key]?.[field] })),
);
check(
  "a window is a positive number when present",
  numbers.every((n) => typeof n.value === "number" && n.value > 0),
  JSON.stringify(numbers.filter((n) => typeof n.value !== "number" || !(n.value > 0))),
);
const flags = keys.flatMap((key) =>
  (["reasoning", "toolCall"] as const)
    .filter((field) => field in (models[key] ?? {}))
    .map((field) => ({ id: key, field, value: models[key]?.[field] })),
);
check(
  "a capability flag is a boolean when present",
  flags.every((f) => typeof f.value === "boolean"),
  JSON.stringify(flags.filter((f) => typeof f.value !== "boolean")),
);
const effortLists = keys
  .filter((key) => "efforts" in (models[key] ?? {}))
  .map((key) => models[key]?.efforts);
check(
  "a level list is a non-empty list of strings when present",
  effortLists.every((e) => Array.isArray(e) && e.length > 0 && e.every((v) => typeof v === "string")),
  JSON.stringify(effortLists),
);

// 溯源：每条都要说得出是从哪儿看到的，且排过序（同一条数据两次写出来得一样）。
const noSource = keys.filter((key) => !Array.isArray(models[key]?.sources) || models[key]?.sources?.length === 0);
check("every entry says where it was seen", noSource.length === 0, noSource.join(", "));
const unsortedSources = keys.filter((key) => {
  const list = (models[key]?.sources ?? []) as string[];
  return JSON.stringify(list) !== JSON.stringify([...list].sort());
});
check("the sources are sorted", unsortedSources.length === 0, unsortedSources.join(", "));

// 键按字母序，且已经是归一化后的写法：表是按键查的，这两种不变量一破，完全命中那
// 一级就悄悄失效了（只能靠近似兜着，那一步会漏、也会配错）。
check("the keys are alphabetical", JSON.stringify(keys) === JSON.stringify([...keys].sort()), JSON.stringify(keys));
const unnormalized = keys.filter((key) => normalizeModelId(key) !== key);
check("every key is already in the normalised form", unnormalized.length === 0, unnormalized.join(", "));

console.log("");
console.log("归一化：小写、去厂商前缀、去日期尾巴、点与下划线折成连字符");

const normalised: [string, string][] = [
  // 厂商前缀 + 四位数日期尾巴：表里就是这么存的
  ["deepseek/deepseek-v4.1-flash-1017", "deepseek-v4-1-flash"],
  // 压缩写法里粘着的日期尾巴也去掉，这是近似那一级能对上标准写法的前提
  ["xopdeepseekv4flash0731", "xopdeepseekv4flash"],
  ["deepseek-v4-flash-20250731", "deepseek-v4-flash"],
  // 大小写：星火只认小写的模型名，表只有一种写法
  ["xopGLM5.3", "xopglm5-3"],
  ["GLM-5.1", "glm-5-1"],
  // 点与下划线都折成连字符
  ["meituan/longcat_flash.lite", "longcat-flash-lite"],
  // 重复的连字符收成一个
  ["deepseek--v4---flash", "deepseek-v4-flash"],
  // 首尾的连字符去掉
  ["-spark-x2.6-", "spark-x2-6"],
  // 整串数字、或者去完最后一位还是数字的，不当日期尾巴
  ["1017", "1017"],
  ["xop3qwen235b2507", "xop3qwen235b"],
];
for (const [input, want] of normalised) {
  const got = normalizeModelId(input);
  check(`${input} → ${want}`, got === want, got);
}
check("an empty id stays empty", normalizeModelId("") === "", JSON.stringify(normalizeModelId("")));
check("a bare slash leaves nothing", normalizeModelId("///") === "");

console.log("");
console.log("完全命中：归一化后一样的 id 就是那条");

const flash41 = commonTraitsOf("deepseek-v4.1-flash");
check("deepseek-v4.1-flash is in the table", flash41 !== null);
check("with the measured window", flash41?.contextWindow === 1000000, JSON.stringify(flash41?.contextWindow));
check("and the measured output limit", flash41?.maxOutputTokens === 384000, JSON.stringify(flash41?.maxOutputTokens));
check(
  "and the thinking levels",
  JSON.stringify(flash41?.efforts) === JSON.stringify(["low", "high", "max"]),
  JSON.stringify(flash41?.efforts),
);
check("the same entry is found through a vendor prefix", commonTraitsOf("nvidia/deepseek-v4.1-flash-1017")?.contextWindow === 1000000);
// 代码目录里那份写法（`Spark-X2.6`）与表里的键是同一个模型
check("the code catalogue's spelling finds the entry", commonTraitsOf("Spark-X2.6") !== null);

// 空壳：认识这个 id，只是参数不知道。它与 null 是两件事。
const shell = commonTraitsOf("spark-x2.5");
check("an entry with no parameters is {} rather than null", shell !== null && Object.keys(shell).length === 0, JSON.stringify(shell));

console.log("");
console.log("近似命中：压缩写法接到标准写法上");

// 星火报的是 `xopdeepseekv4flash0731`：表里有标准写法，就该接上它
const approximated = commonTraitsOf("xopdeepseekv4flash0731");
check("xopdeepseekv4flash0731 is answered", approximated !== null, JSON.stringify(approximated));
check(
  "and it is deepseek-v4-flash's entry, not the v4.1 one",
  approximated?.contextWindow === commonTraitsOf("deepseek-v4-flash")?.contextWindow,
  JSON.stringify([approximated?.contextWindow, commonTraitsOf("deepseek-v4-flash")?.contextWindow]),
);
check("the compressed glm id reaches glm-5-1", commonTraitsOf("xopglm51")?.contextWindow === 200000, JSON.stringify(commonTraitsOf("xopglm51")));
check(
  "a compressed id with no standard entry is not given a neighbour's numbers",
  commonTraitsOf("xsparkx2flash") === null,
  JSON.stringify(commonTraitsOf("xsparkx2flash")),
);

console.log("");
console.log("两个候选都像的时候按没有处理");

// 造一份键集来测歧义：两个键都是这个 id 的后缀（压缩后 `deepseekv4flash` 与
// `v4flash`），真表里不该出现这种组合，所以不往入库的数据里加条目。
const ambiguous = ["deepseek-v4-flash", "v4-flash"];
check("one candidate alone is a hit", lookupModelId("xopdeepseekv4flash0731", [ambiguous[0]!]) === "deepseek-v4-flash");
check("the other alone is a hit too", lookupModelId("xopdeepseekv4flash0731", [ambiguous[1]!]) === "v4-flash");
check("two candidates are an ambiguity, answered with null", lookupModelId("xopdeepseekv4flash0731", ambiguous) === null);
check("and it stays null with three", lookupModelId("xopdeepseekv4flash0731", [...ambiguous, "deepseek-v4-flash-0731"]) === null);

console.log("");
console.log("数字不同就是不同模型");

// v4 与 v4.1 是上一轮被混起来的那个坑：窗口 1048576 与 1000000 不是一回事
check(
  "deepseek-v4-flash keeps its own window",
  commonTraitsOf("deepseek-v4-flash")?.contextWindow === 1048576,
  JSON.stringify(commonTraitsOf("deepseek-v4-flash")?.contextWindow),
);
check(
  "and does not borrow the v4.1 one's",
  commonTraitsOf("deepseek-v4-flash")?.contextWindow !== 1000000,
  JSON.stringify(commonTraitsOf("deepseek-v4-flash")),
);
check(
  "v4.1 is not reachable from v4 alone",
  lookupModelId("deepseek-v4-flash", ["deepseek-v4-1-flash"]) === null,
  JSON.stringify(lookupModelId("deepseek-v4-flash", ["deepseek-v4-1-flash"])),
);
check(
  "and the compressed v4.1 id does not reach the v4 entry",
  lookupModelId("deepseek-v41flash", ["deepseek-v4-flash"]) === null,
  JSON.stringify(lookupModelId("deepseek-v41flash", ["deepseek-v4-flash"])),
);
// 同一件事在星火的压缩写法上也成立：`xopglm5.3` 不许接到 `glm-5-1` 上
check(
  "xopglm5.3 does not reach glm-5-1",
  commonTraitsOf("xopglm5.3") === null,
  JSON.stringify(commonTraitsOf("xopglm5.3")),
);

console.log("");
console.log("表里没有的 id 是 null，不造最小形状");

check("an unknown id is null", commonTraitsOf("no-such-model") === null);
check("an empty id is null", commonTraitsOf("") === null);
check("a shorter prefix of a real key is not a hit", commonTraitsOf("deepseek-v4") === null, JSON.stringify(commonTraitsOf("deepseek-v4")));

console.log("");
console.log("返回的是副本，改它不影响表");

const first = commonTraitsOf("deepseek-v4.1-flash");
first?.efforts?.push("bogus");
if (first) first.contextWindow = 1;
const second = commonTraitsOf("deepseek-v4.1-flash");
check("the levels did not change", JSON.stringify(second?.efforts) === JSON.stringify(["low", "high", "max"]), JSON.stringify(second?.efforts));
check("the window did not change", second?.contextWindow === 1000000, JSON.stringify(second?.contextWindow));
check("two lookups are not the same object", first !== second);
// 每个已入库的键都要能查回自己（上一条不变量从查询这一侧再验一次）
const unreachable = keys.filter((key) => commonTraitsOf(key) === null);
check("every key in the file can be looked up", unreachable.length === 0, unreachable.join(", "));

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
