// test/minimax-credits-view-check.ts — 面板的积分明细与路由的判定要一个口径。
//
//   node --experimental-strip-types test/minimax-credits-view-check.ts
//
// 离线：不问任何上游，明细是造出来的快照。
//
// 同一个账号可能「面板有积分、路由判没钱」：路由的判定跳过已过期的条目
// （pointsFromLedger），面板的明细原先不跳过。改一处不改另一处，两边说的
// 就不是同一件事了。

import fs from "node:fs";

const DATA_DIR = "/tmp/opencode/test-minimax-credits-view";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const { kindOf } = await import("../lib/provider-kinds.ts");
const { addAccount, provider } = await import("../lib/providers.ts");

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

console.log("");
console.log("面板的积分明细不含已过期的条目");

{
  const account = addAccount({ platform: "minimax", alias: "有积分的账号" });
  const row = provider(account.id!);
  const kind = kindOf("minimax");
  const now = Date.now();

  const snapshot = {
    minimax: {
      [account.id!]: {
        credits: [
          // 已经过期的：平台不会拿它付账，路由的判定也不认它。
          { granted: 100, remaining: 100, consumed: 0, expireAtMs: now - 60_000, creditType: 2 },
          // 还在的。
          { granted: 50, remaining: 40, consumed: 10, expireAtMs: now + 10 * 24 * 3600_000, creditType: 2 },
        ],
      },
    },
  };

  const views = kind && row ? kind.quotas(row, snapshot as never) : [];
  const credits = views[0]?.credits;
  check("有积分明细", Boolean(credits), JSON.stringify(views));

  const lots = credits?.lots ?? [];
  check("明细只有一条", lots.length === 1, JSON.stringify(lots));
  check(
    "剩下的是没过期的那笔",
    lots[0]?.remaining === 40,
    JSON.stringify(lots.map((lot: any) => lot.remaining)),
  );
  check(
    "剩下的额度也不含过期的那笔",
    credits?.remaining === 40,
    String(credits?.remaining),
  );
  check(
    "note 里说明只算未过期的",
    String(credits?.note ?? "").includes("只算未过期的"),
    String(credits?.note),
  );
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
