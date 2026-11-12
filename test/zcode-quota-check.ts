// test/zcode-quota-check.ts — ZCode 的额度：问到了，但一个桶都没有。
//
//   node --experimental-strip-types test/zcode-quota-check.ts
//
// 离线：快照是手写的合成数据，一个请求都不发出去，不花任何额度。
//
// 套餐用完（或到期）之后，平台照样回 200，只是什么都不给：
//
//   {"code":0,"data":{"server_time":...,"plans":[],"balances":[]}}
//
// 所以「空桶」是一个答复 —— 用完了 —— 不是「没有配额」的默认值。三种形状必须
// 分开，混在一起就会把用尽的账号报成 ready：
//
//   1. 没有这个账号的条目，或 quota 是 null：没问到（或问失败了）。不知道，
//      不算用尽，面板上也没有额度卡 —— 显示成 0 就是编数字。
//   2. quota.buckets 是空数组：问到了，平台一个额度桶都没给。用尽。面板上要有
//      一张卡说明情况。
//   3. 有桶：按桶算。
//
// 最后一节把旧规则（空桶当「不知道」）喂给同一套断言，要求它正好在第三条上
// 变红：两种写法都过的测试，在规则退回去的那天不会报警。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  HealthSnapshot,
  ProviderRow,
  QuotaView,
} from "../lib/provider-kinds.ts";

// The ZCode session layer reads config while the module is evaluated, so the
// data directory has to be set before the import (same as
// test/zcode-system-check.ts).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-quota-"));
process.env.BUDDY_DATA_DIR = DATA_DIR;

await import("../lib/kinds/zcode.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");

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

const ACCOUNT = {
  id: "acc-zcode-1",
  platform: "zcode",
  kind: "zcode",
  region: "",
  alias: "",
  enabled: true,
  weight: 0,
  policy: "single",
  createdAt: 0,
  updatedAt: 0,
} as ProviderRow;

/** 快照里这一个账号那一段：`undefined` = 连条目都没有。 */
type Entry = { quota: unknown } | undefined;

const snapshotOf = (entry: Entry): HealthSnapshot =>
  ({ zcode: entry ? { [ACCOUNT.id]: entry } : {} }) as unknown as HealthSnapshot;

/** 平台报的一个桶，数字取一份真答复的形状。 */
const BUCKET = {
  showName: "GLM-5.3",
  total: 3_000_000,
  used: 120_000,
  remaining: 2_880_000,
  expiresAt: "2026-12-01T00:00:00.000Z",
  periodEnd: "2026-12-01T00:00:00.000Z",
};

/** 一个形状，以及它该得到什么。 */
interface Case {
  name: string;
  entry: Entry;
  /** true = 额度用尽。 */
  spent: boolean;
  /** null = 面板上不该有额度卡（不知道，不是 0）。 */
  view: {
    total: number;
    used: number;
    remaining: number;
    lots: number;
    note: boolean;
  } | null;
}

const EMPTY_BUCKETS = "quota 是空桶（问到了，一个桶都没给）";

const CASES: Case[] = [
  { name: "没有这个账号的条目", entry: undefined, spent: false, view: null },
  { name: "quota 是 null（没问到）", entry: { quota: null }, spent: false, view: null },
  {
    name: EMPTY_BUCKETS,
    entry: { quota: { buckets: [] } },
    spent: true,
    view: { total: 0, used: 0, remaining: 0, lots: 0, note: true },
  },
  {
    name: "有一个还剩额的桶",
    entry: { quota: { buckets: [BUCKET] } },
    spent: false,
    view: { total: 3_000_000, used: 120_000, remaining: 2_880_000, lots: 1, note: true },
  },
  {
    name: "有桶但剩余是 0",
    entry: { quota: { buckets: [{ ...BUCKET, remaining: 0 }] } },
    spent: true,
    view: { total: 3_000_000, used: 120_000, remaining: 0, lots: 1, note: true },
  },
];

/** 一套规则：从快照的一个条目读出「用尽了吗」与「面板上是什么」。 */
interface Rule {
  outOfCredits: (entry: Entry) => boolean;
  views: (entry: Entry) => QuotaView[];
}

/**
 * 跑全部形状，交出没过的那些名字。
 *
 * 反证与正式断言共用这一份：旧规则要红，而且红的必须是同一套判据。
 */
function failures(rule: Rule): string[] {
  const bad: string[] = [];
  for (const one of CASES) {
    const spent = rule.outOfCredits(one.entry);
    const views = rule.views(one.entry);
    const credits = views[0]?.credits;
    const ok =
      spent === one.spent &&
      (one.view === null
        ? views.length === 0
        : views.length === 1 &&
          credits !== undefined &&
          credits.total === one.view.total &&
          credits.used === one.view.used &&
          credits.remaining === one.view.remaining &&
          credits.lots.length === one.view.lots &&
          (one.view.note ? credits.note.trim().length > 0 : credits.note.trim().length === 0));
    if (!ok) bad.push(one.name);
  }
  return bad;
}

const kind = kindOf("zcode");
if (!kind) {
  console.log("  FAIL 注册表里没有 zcode —— lib/kinds/zcode.ts 没有登记");
  process.exit(1);
}

const current: Rule = {
  outOfCredits: (entry) => kind.outOfCredits(ACCOUNT, snapshotOf(entry)),
  views: (entry) => kind.quotas(ACCOUNT, snapshotOf(entry)),
};

section("三种形状分开：问到了但空了就是用尽");

for (const one of CASES) {
  const spent = current.outOfCredits(one.entry);
  check(
    `${one.name} → 用尽 ${one.spent}`,
    spent === one.spent,
    `得到 ${spent}`,
  );

  const views = current.views(one.entry);
  if (one.view === null) {
    check(`${one.name} → 没有额度卡`, views.length === 0, JSON.stringify(views));
    continue;
  }

  const credits = views[0]?.credits;
  check(`${one.name} → 一张额度卡`, views.length === 1, JSON.stringify(views));
  check(
    `${one.name} → 卡上是这个账号`,
    views[0]?.accountId === ACCOUNT.id && views[0]?.upstreamId === ACCOUNT.platform,
    JSON.stringify(views[0]),
  );
  check(`${one.name} → 总数 ${one.view.total}`, credits?.total === one.view.total, String(credits?.total));
  check(`${one.name} → 已用 ${one.view.used}`, credits?.used === one.view.used, String(credits?.used));
  check(
    `${one.name} → 剩余 ${one.view.remaining}`,
    credits?.remaining === one.view.remaining,
    String(credits?.remaining),
  );
  check(
    `${one.name} → ${one.view.lots} 个批次`,
    credits?.lots.length === one.view.lots,
    String(credits?.lots.length),
  );
  check(
    `${one.name} → ${one.view.note ? "有话要说" : "没有说明"}`,
    one.view.note
      ? (credits?.note.trim().length ?? 0) > 0
      : (credits?.note.trim().length ?? 0) === 0,
    JSON.stringify(credits?.note),
  );
}

section("恢复时间：桶空了就是不知道，不编一个");

check(
  "空桶没有恢复时间",
  kind.recoverAt?.(ACCOUNT, snapshotOf({ quota: { buckets: [] } })) === null,
  String(kind.recoverAt?.(ACCOUNT, snapshotOf({ quota: { buckets: [] } }))),
);
check(
  "没问到也没有恢复时间",
  kind.recoverAt?.(ACCOUNT, snapshotOf({ quota: null })) === null,
  String(kind.recoverAt?.(ACCOUNT, snapshotOf({ quota: null }))),
);
check(
  "有桶就取它的到期时间",
  kind.recoverAt?.(ACCOUNT, snapshotOf({ quota: { buckets: [BUCKET] } })) ===
    Date.parse(BUCKET.expiresAt),
  String(kind.recoverAt?.(ACCOUNT, snapshotOf({ quota: { buckets: [BUCKET] } }))),
);

section("反证：空桶当「不知道」，第三条断言就红");

// 改之前的样子：空桶读成「不知道」，面板上也没有卡。要求同一套断言正好在第三
// 条上失败 —— 否则这个测试证明不了它在防什么。
const before: Rule = {
  outOfCredits: (entry) => {
    const buckets = ((entry as any)?.quota?.buckets ?? []) as any[];
    if (!buckets.length) return false;
    return buckets.every((bucket) => Number(bucket?.remaining ?? 0) <= 0);
  },
  views: (entry) => {
    const buckets = ((entry as any)?.quota?.buckets ?? []) as any[];
    return buckets.length ? current.views(entry) : [];
  },
};

const green = failures(current);
const red = failures(before);
check("现在的规则：一条都不过不了", green.length === 0, green.join(","));
check(
  "旧规则：只在那一条上红",
  red.length === 1 && red[0] === EMPTY_BUCKETS,
  red.join(","),
);
check("旧规则确实把空桶读成没用尽", before.outOfCredits({ quota: { buckets: [] } }) === false);
check("旧规则确实不给空桶出卡", before.views({ quota: { buckets: [] } }).length === 0);

// Close the database before removing its directory: on Windows an open file
// cannot be deleted (EPERM), so the handle has to go first.
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
