// test/account-id-migration-check.ts — 老库的账号 id 换号。
//
//   node --experimental-strip-types test/account-id-migration-check.ts
//
// 离线：两个临时数据目录，不起服务，不发请求，不碰真凭据。
//
// 账号 id 现在是自增整数（lib/providers.ts 的 nextAccountId），生产库里还是老
// 形态（`tokenrhythm`、`qoder`、`workbuddy-cn`）。启动时的
// `migrateAccountIds`（lib/store.ts）把它们换成数字，凭据与冷却跟着搬家。
//
// 这里查的是：
//
//   1. 开库时自动迁移：id 变成数字且不重复，编号按 created_at 升序
//   2. alias 为空的那几个填成旧 id
//   3. 已经有 alias 的账号（「中转站 1」）alias 不变
//   4. 四类凭据都在新 id 下、旧 id 下一个不剩；没有对应账号的凭据原样留着
//   5. 冷却那行跟着换号
//   6. 冒号边界：`qoder` 与 `qoder-cn` 两个账号的凭据不串
//   7. 幂等：再跑一次迁移，id、alias、凭据一个字节都不变

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "account-id-migration-"));
const SECOND_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "account-id-migration-2-"));
// 数据目录要在库被打开之前定下来：库是第一次用的时候才开的。
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { store, closeStore, migrateAccountIds } = await import("../lib/store.ts");

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
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

/** 一行账号。只有迁移看得上的那几列。 */
function addProvider(id: string, alias: string, createdAt: number): void {
  store()
    .prepare(
      "INSERT INTO provider (id, platform, alias, enabled, weight, created_at, updated_at) VALUES (?, ?, ?, 1, 100, ?, ?)",
    )
    .run(id, "qoder", alias, createdAt, createdAt);
}

/** 一行凭据。内容是什么不影响换号。 */
function addSecret(id: string, kind: string): void {
  store()
    .prepare("INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, '{}', ?)")
    .run(id, kind, Date.now());
}

/** 每个账号的 id，按 created_at 排。 */
function idsByCreation(): { id: string; alias: string; createdAt: number }[] {
  const rows = store()
    .prepare("SELECT id, alias, created_at FROM provider ORDER BY created_at, id")
    .all() as { id?: string; alias?: string; created_at?: number }[];
  return rows.map((row) => ({
    id: String(row.id),
    alias: String(row.alias ?? ""),
    createdAt: Number(row.created_at ?? 0),
  }));
}

/** 全部凭据 id，排过序。 */
function secretIds(): string[] {
  const rows = store().prepare("SELECT id FROM secrets ORDER BY id").all() as { id?: string }[];
  return rows.map((row) => String(row.id));
}

/** 冷却表里的账号 id。 */
function cooldownIds(): string[] {
  const rows = store().prepare("SELECT provider_id FROM cooldown ORDER BY provider_id").all() as {
    provider_id?: string;
  }[];
  return rows.map((row) => String(row.provider_id));
}

/* ------------------------------------------------------------------ */

section("老库");

addProvider("qoder", "", 1000);
addProvider("tokenrhythm-2", "", 2000);
// 生产上有人把账号改过名：迁移不能把名字换成旧 id。
addProvider("workbuddy-cn", "中转站 1", 3000);

addSecret("session:provider:qoder", "session");
addSecret("key:provider:qoder:account", "key");
addSecret("session:provider:tokenrhythm-2", "session");
addSecret("key:provider:tokenrhythm-2:account", "key");
addSecret("account:tokenrhythm-2", "account");
// 账号行早就被删掉、凭据留着的两行：没有账号可换，原样不动。
addSecret("key:provider:tokenrhythm:tenant-2", "key");
addSecret("account:tokenrhythm:2", "account");

store()
  .prepare("INSERT INTO cooldown (provider_id, until_ms, reason, updated_at) VALUES (?, ?, ?, ?)")
  .run("qoder", Date.now() + 600_000, "429", Date.now());

check(
  "造出来的老库是「平台名」形态",
  idsByCreation().map((row) => row.id).join(",") === "qoder,tokenrhythm-2,workbuddy-cn",
  idsByCreation().map((row) => row.id).join(","),
);

section("开库时自动迁移");

// 关掉再开：走的是 openDatabase 里那条路，不是直接调函数。
closeStore();
store();

const migrated = idsByCreation();
check(
  "id 全变成数字，按建出来的先后从 1 排起",
  migrated.map((row) => row.id).join(",") === "1,2,3",
  migrated.map((row) => row.id).join(","),
);
check(
  "id 不重复",
  new Set(migrated.map((row) => row.id)).size === migrated.length,
  migrated.map((row) => row.id).join(","),
);
check(
  "alias 为空的两个填成旧 id，改过名的那个不动",
  migrated.map((row) => row.alias).join("|") === "qoder|tokenrhythm-2|中转站 1",
  migrated.map((row) => row.alias).join("|"),
);

const secrets = secretIds();
check(
  "qoder 的凭据在新 id 下",
  secrets.includes("session:provider:1") && secrets.includes("key:provider:1:account"),
  secrets.join(" "),
);
check(
  "tokenrhythm-2 的三行凭据在新 id 下",
  secrets.includes("session:provider:2") &&
    secrets.includes("key:provider:2:account") &&
    secrets.includes("account:2"),
  secrets.join(" "),
);
check(
  "旧 id 下的凭据一个不剩",
  !secrets.some((id) => /qoder|tokenrhythm-2|workbuddy-cn/.test(id)),
  secrets.join(" "),
);
check(
  "没有对应账号的凭据原样留着",
  secrets.includes("key:provider:tokenrhythm:tenant-2") && secrets.includes("account:tokenrhythm:2"),
  secrets.join(" "),
);
check("冷却那行跟着换号", cooldownIds().join(",") === "1", cooldownIds().join(","));

section("幂等");

const before = JSON.stringify({
  accounts: idsByCreation(),
  secrets: secretIds(),
  cooldown: cooldownIds(),
});
migrateAccountIds(store());
const after = JSON.stringify({
  accounts: idsByCreation(),
  secrets: secretIds(),
  cooldown: cooldownIds(),
});
check("再跑一次，一个字节都不变", before === after, `${before} → ${after}`);

section("冒号边界");

// 另一个库：两个 id 互为前缀的账号同时存在，凭据不能串。
closeStore();
process.env.BUDDY_DATA_DIR = SECOND_DIR;
store();

addProvider("qoder", "", 1000);
addProvider("qoder-cn", "", 2000);
addSecret("session:provider:qoder", "session");
addSecret("key:provider:qoder:account", "key");
addSecret("session:provider:qoder-cn", "session");
addSecret("key:provider:qoder-cn:account", "key");

migrateAccountIds(store());

const boundary = idsByCreation();
check(
  "两个账号各自拿到自己的号",
  boundary.map((row) => `${row.id}/${row.alias}`).join(",") === "1/qoder,2/qoder-cn",
  boundary.map((row) => `${row.id}/${row.alias}`).join(","),
);
const boundarySecrets = secretIds();
check(
  "qoder 的凭据在 1，qoder-cn 的凭据在 2，没有交叉",
  boundarySecrets.join(" ") ===
    "key:provider:1:account key:provider:2:account session:provider:1 session:provider:2",
  boundarySecrets.join(" "),
);
check(
  "没有凭据被前缀匹配连坐",
  boundarySecrets.length === 4,
  String(boundarySecrets.length),
);

closeStore();
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SECOND_DIR, { recursive: true, force: true });
console.log("");
if (fail === 0) {
  console.log(`全部通过（${pass} 项）`);
} else {
  console.log(`FAIL: ${fail} 项没过，${pass} 项过了`);
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail === 0 ? 0 : 1);
