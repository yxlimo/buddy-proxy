// test/balance-account-check.ts — 余额账号：扫描、排序、钉住。
//
//   node --experimental-strip-types test/balance-account-check.ts
//
// 中转站的赠金会过期，所以最先到期的那个账户该先用。这是定时的一件事：
// 扫描余额 → 按到期排序 → 钉住第一个。请求撞上「余额不足」时，钩子重新
// 扫描、重新钉一个别的接手。
//
// 钱包是假的：扫描函数收一个「从哪儿读钱包」的函数（跟
// lib/router/benefits.ts 一样，默认是真的，测试传假的进来）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenRhythmAccountStatus } from "../lib/tokenrhythm/wallet.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "balance-account-"));
process.env.BUDDY_DATA_DIR = tmp;

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

/* ------------------------------------------------------------------ *
 * 假钱包
 * ------------------------------------------------------------------ */

interface FakeTenant {
  /** 账号行的 id。 */
  accountId: string;
  availableCny: number;
  giftCny: number;
  expiresAt: string;
  hasKey: boolean;
  error?: string;
}

/** 现在钱包长这样。测试改它，扫描就会看到新的数。 */
let tenants: FakeTenant[] = [];

const NEVER = "2099-12-31T15:59:59.000Z";

function tenant(
  index: number,
  availableCny: number,
  giftCny: number,
  expiresAt: string,
  extra: Partial<FakeTenant> = {},
): FakeTenant {
  return { accountId: `tokenrhythm-${index}`, availableCny, giftCny, expiresAt, hasKey: true, ...extra };
}

/** 假钱包：把假租户说成平台会说的那个形状。 */
const fakeWallet = async (): Promise<TokenRhythmAccountStatus[]> =>
  tenants.map((t) => ({
    accountId: t.accountId,
    account: `acct-${t.accountId}`,
    name: `账号 ${t.accountId}`,
    hasKey: t.hasKey,
    credential: null,
    wallet: t.error
      ? null
      : ({
          availableCny: t.availableCny,
          giftAvailableCny: t.giftCny,
          currency: "CNY",
          rechargeCny: t.availableCny - t.giftCny,
          giftTotalCny: t.giftCny,
          giftStatus: "ACTIVE",
          asOf: new Date().toISOString(),
        } as TokenRhythmAccountStatus["wallet"]),
    credits: t.error
      ? null
      : ({
          lots: [],
          summary: { expiringBalanceCny: t.giftCny, nextExpiryAt: t.expiresAt },
        } as TokenRhythmAccountStatus["credits"]),
    error: t.error ?? null,
  }));

const { scanBalance, setBalanceAccount, pinnedBalanceAccount, clearBalanceAccount } = await import(
  "../lib/tokenrhythm/balance.ts"
);

console.log("扫描余额");

tenants = [
  tenant(1, 100, 0, NEVER), // 充值的本金：不到期
  tenant(2, 18, 18, "2026-11-21T04:28:10.883Z"), // 最先到期
  tenant(3, 18, 18, "2026-12-01T00:00:00.000Z"), // 后到期
];

const balances = await scanBalance("tokenrhythm", fakeWallet);
check("扫到了三个账户", balances.length === 3, JSON.stringify(balances.map((b) => b.accountId)));
check("最先到期的排第一", balances[0]?.accountId === "tokenrhythm-2", JSON.stringify(balances.map((b) => b.accountId)));
check("本金排最后", balances[2]?.accountId === "tokenrhythm-1", JSON.stringify(balances.map((b) => b.accountId)));
check(
  "余额是钱包说的那个数",
  balances[0]?.availableCny === 18 && balances[0]?.giftCny === 18,
  JSON.stringify(balances[0]),
);
check(
  "到期时刻是钱包说的那个",
  balances[0]?.expiresAt === Date.parse("2026-11-21T04:28:10.883Z"),
  String(balances[0]?.expiresAt),
);

console.log("");
console.log("没用的账户不算");

tenants = [
  tenant(1, 0, 0, NEVER), // 没钱
  tenant(2, 18, 18, "2026-11-21T04:28:10.883Z", { hasKey: false }), // 没有 key
  tenant(3, 18, 18, "2026-12-01T00:00:00.000Z", { error: "登录过期" }), // 查询出错
  tenant(4, 18, 18, "2026-12-01T00:00:00.000Z"), // 能用
];
const usable = await scanBalance("tokenrhythm", fakeWallet);
// 没钱的、没 key 的不算；查不到余额的照样算（余额读不到不等于没钱），
// 只是排在有余额的后面。
check(
  "没钱、没 key 的不算，查不到余额的留着",
  usable.map((b) => b.accountId).join(",") === "tokenrhythm-4,tokenrhythm-3",
  JSON.stringify(usable.map((b) => b.accountId)),
);

console.log("");
console.log("钉住");

tenants = [
  tenant(1, 100, 0, NEVER),
  tenant(2, 18, 18, "2026-11-21T04:28:10.883Z"),
  tenant(3, 18, 18, "2026-12-01T00:00:00.000Z"),
];
clearBalanceAccount("tokenrhythm");
check("一开始没钉住谁", pinnedBalanceAccount("tokenrhythm") === null);

const pinned = await setBalanceAccount("tokenrhythm", fakeWallet);
check("钉住的是最先到期的那个", pinned?.accountId === "tokenrhythm-2", String(pinned?.accountId));
check(
  "钉住的可以问出来",
  pinnedBalanceAccount("tokenrhythm")?.accountId === "tokenrhythm-2",
  String(pinnedBalanceAccount("tokenrhythm")?.accountId),
);

console.log("");
console.log("余额变了就换钉");

tenants = [
  tenant(1, 100, 0, NEVER),
  tenant(2, 18, 0, NEVER), // 赠金用完了
  tenant(3, 18, 18, "2026-12-01T00:00:00.000Z"),
];
const repinned = await setBalanceAccount("tokenrhythm", fakeWallet);
check("换成赠金还剩着的那个", repinned?.accountId === "tokenrhythm-3", String(repinned?.accountId));
check("问出来也是新的那个", pinnedBalanceAccount("tokenrhythm")?.accountId === "tokenrhythm-3", String(pinnedBalanceAccount("tokenrhythm")?.accountId));

console.log("");
console.log("没有能用的账户就钉不上");

tenants = [tenant(1, 0, 0, NEVER)];
const none = await setBalanceAccount("tokenrhythm", fakeWallet);
check("钉不上", none === null, String(none));
check("之前的钉也没了", pinnedBalanceAccount("tokenrhythm") === null);

console.log("");
console.log(problems.length ? `FAIL: ${problems.length} 项` : `全部通过（${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
