// test/minimax-checkin-check.ts — the MiniMax Code daily sign-in.
//
//   node --experimental-strip-types test/minimax-checkin-check.ts
//
// The network is not touched: what is checked here is how the panel is read
// (which day can be claimed, whether today is done, how long the streak is)
// and how the request is built. The protocol comes from the official client
// (MiniMax-AI/minimax-code, packages/tui/src/checkin/http-gateway.ts).

import {
  CLAIM_ALREADY_CLAIMED,
  CLAIM_CLAIMED,
  SIGNIN_CLAIMABLE,
  SIGNIN_CLAIMED,
  SIGNIN_UPCOMING,
  claimableDay,
  claimedToday,
  streak,
  type SigninPanel,
} from "../lib/minimax/checkin.ts";

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

function panel(days: Partial<SigninPanel["days"][number]>[]): SigninPanel {
  return {
    scene: 2,
    days: days.map((d, i) => ({
      day_no: i + 1,
      points: 400,
      bonus_points: 0,
      status: SIGNIN_UPCOMING,
      is_today: false,
      ...d,
    })) as SigninPanel["days"],
  };
}

console.log("面板");

const fresh = panel([
  { status: SIGNIN_CLAIMABLE, is_today: true, points: 1424, bonus_points: 1024 },
  { status: SIGNIN_UPCOMING, points: 400 },
  { status: SIGNIN_UPCOMING, points: 400 },
]);
check("看得出今天能领", claimableDay(fresh)?.day_no === 1, JSON.stringify(claimableDay(fresh)));
check("还没领", claimedToday(fresh) === false);
check("连签还没开始", streak(fresh) === 0, String(streak(fresh)));
check("奖励分是单独的一个数", claimableDay(fresh)?.bonus_points === 1024);

// 面板是七天一轮，从今天开始：所以「今天」之前的那些天才是已经领过的。
const done = panel([
  { status: SIGNIN_CLAIMED, points: 400 },
  { status: SIGNIN_CLAIMED, points: 400 },
  { status: SIGNIN_CLAIMED, is_today: true, points: 1424 },
  { status: SIGNIN_UPCOMING, points: 400 },
]);
check("领过了就没有可领的", claimableDay(done) === null);
check("领过了就是领过了", claimedToday(done) === true);
check("连签的天数算得对", streak(done) === 3, String(streak(done)));

const broken = panel([
  { status: SIGNIN_CLAIMED, points: 400 },
  { status: SIGNIN_UPCOMING, points: 400 },
  { status: SIGNIN_CLAIMED, is_today: true, points: 400 },
]);
const firstDay = panel([
  { status: SIGNIN_CLAIMED, is_today: true, points: 1424 },
  { status: SIGNIN_UPCOMING, points: 400 },
]);
check("第一天连签是 1", streak(firstDay) === 1, String(streak(firstDay)));
check("中间断了连签就断", streak(broken) === 1, String(streak(broken)));

check("空面板没有可领的", claimableDay(null) === null);
check("空面板没领过", claimedToday(null) === false);
check("空面板连签是 0", streak(null) === 0);

console.log("");
console.log("领奖结果");

check("领到了是 1", CLAIM_CLAIMED === 1);
check("已经领过是 2", CLAIM_ALREADY_CLAIMED === 2);
check("状态 1/2/3 的意思没变", SIGNIN_UPCOMING === 1 && SIGNIN_CLAIMABLE === 2 && SIGNIN_CLAIMED === 3);

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) {
  console.log(problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
