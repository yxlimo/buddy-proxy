// test/tokenrhythm-check.ts — TokenRhythm 的租户选择与余额不足时的回退。
//
//   node --experimental-strip-types test/tokenrhythm-check.ts
//
// 覆盖三件事：
//   1. 租户按「先到期的赠金先用」排序；
//   2. 没钱、没 key、查询出错的租户被排除；
//   3. 上游说「余额不足」时换下一个租户，而不是把错误原样抛出去。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenrhythm-check-"));
process.env.BUDDY_DATA_DIR = tmp;

const {
  markTenantOutOfMoney,
  pickTenant,
  pickTenants,
} = await import("../lib/tokenrhythm/wallet.ts");
const { TokenRhythmNoBalanceError } = await import("../lib/tokenrhythm/transport.ts");

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

/** 一个租户的样子。 */
function tenant(
  index: number,
  available: number,
  gift: number,
  nextExpiryAt: string | null,
  extra: Partial<Record<string, unknown>> = {},
): any {
  return {
    index,
    account: `190***${index}`,
    name: `租户 ${index}`,
    hasKey: true,
    wallet: { availableCny: available, giftAvailableCny: gift },
    credits: nextExpiryAt ? { summary: { nextExpiryAt } } : null,
    error: null,
    ...extra,
  };
}

console.log("");
console.log("选租户");

const soon = "2026-11-19T04:28:10.883Z";
const later = "2026-11-20T04:28:10.883Z";
const never = "2099-12-31T15:59:59.000Z";

const statuses = [
  tenant(1, 100, 0, never), // 赠金是永久的 → 最后用
  tenant(2, 18, 18, soon), // 最先到期 → 先用
  tenant(3, 18, 18, later),
];

check("先到期的那批赠金先用", pickTenant(statuses)?.index === 2, String(pickTenant(statuses)?.index));
// 有赠金的先用，赠金是永久的那个排最后 —— 它是最后的备选。
check("有赠金的先上", pickTenants(statuses).length === 2, String(pickTenants(statuses).length));
check("永久赠金的那个排最后", pickTenants(statuses).every((t: any) => t.index !== 1));

console.log("");
console.log("没用的租户");

const mixed = [
  tenant(1, 0, 0, soon), // 没钱
  tenant(2, 18, 18, soon, { hasKey: false }), // 没有 key
  tenant(3, 18, 18, soon, { error: "登录过期" }), // 查询出错
  tenant(4, 5, 5, later), // 能用
  tenant(5, 30, 0, never), // 只有充值的本金，也能用
];
check("没钱、没 key、出错的都排除", pickTenants(mixed).length === 1, String(pickTenants(mixed).length));
check("剩下的是有赠金的那个", pickTenants(mixed)[0]?.index === 4, String(pickTenants(mixed)[0]?.index));
// 都没有赠金的时候，充值的本金才上场。
const noGift = [tenant(1, 30, 0, never), tenant(2, 40, 0, never)];
check("没有赠金就用充值的本金", pickTenants(noGift).length === 2, String(pickTenants(noGift).length));

console.log("");
console.log("没钱了就换一个");

markTenantOutOfMoney(4);
const after = pickTenants(mixed);
check("被标记的租户被排除", !after.some((t: any) => t.index === 4), JSON.stringify(after.map((t: any) => t.index)));
check("其它租户不受影响", after.length === 1, String(after.length));
check("剩下的是那个", after[0]?.index === 5, String(after[0]?.index));

console.log("");
console.log("余额不足的错误");

const err = new TokenRhythmNoBalanceError("账户余额不足，请充值后重试", "trace_123");
check("是 402", err.status === 402, String(err.status));
check("带着 traceId", err.traceId === "trace_123");
check("是它自己的类型", err instanceof TokenRhythmNoBalanceError);
check("是 Error", err instanceof Error);

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
