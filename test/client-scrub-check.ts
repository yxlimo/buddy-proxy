// test/client-scrub-check.ts — 交给客户端的那份上游正文也要抹。
//
//   node --experimental-strip-types test/client-scrub-check.ts
//
// 离线：一个请求都不发，全是进程里造出来的错误。
//
// 网关把上游那句原话交给客户端（重试用尽时客户端拿到的是上游自己的答复，见
// lib/router/upstreams/policy.ts 的 upstreamAnswerError）。上游在 401 / 忙 /
// 风控的正文里回显 key 片段、cookie、邮箱、JWT 是常有的事，所以那一份也要抹
// —— 只抹日志那一侧，等于把这些值直接送到调用方。
//
// 抹的规矩与日志那边是同一套（lib/log-scrub.ts 的 scrubForClient），所以这里
// 验的不是「另一份规则」，而是「同一个规则确实接在了客户端那个出口上」：
//   · 值抹掉，句子还在（字段名在，那句话读得懂）；
//   · 没有敏感值的正文逐字不变（抹过头与没抹一样是坏的）；
//   · 反证：把 scrubForClient 从出口摘掉，第一条就红（值原样出现在 hint 里）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "client-scrub-check-"));
process.env.BUDDY_DATA_DIR = tmp;

const { AuthError } = await import("../lib/credential.ts");
const { withUpstreamAnswer } = await import("../lib/upstream-status.ts");
const { scrubForClient } = await import("../lib/log-scrub.ts");
const { upstreamStatusError, runWithRetries } = await import("../lib/router/upstreams/policy.ts");

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

function section(title: string): void {
  console.log("");
  console.log(title);
}

/**
 * 重试用尽之后客户端拿到的那个 hint。
 *
 * 客户端能看到的只有 message 与 hint，而 message 是「哪一类失败」的标签 ——
 * 上游的正文只可能出现在 hint 里。所以这一条就是「客户端拿到了什么」。
 *
 * 走的是真的那条路（runWithRetries 里 gaveUp 那一支）：限流等满三回就停手，
 * 停手时用的是上游自己的状态与正文（见 policy.ts 的 stop）。
 */
async function clientHint(error: unknown): Promise<{ hint: string; message: string; status: number }> {
  try {
    await runWithRetries({ id: "1" }, "test", async (): Promise<never> => {
      throw error;
    }, { sleep: async () => {} });
  } catch (e: any) {
    return {
      hint: String(e?.hint ?? ""),
      message: String(e?.message ?? ""),
      status: Number(e?.status ?? 0),
    };
  }
  return { hint: "", message: "", status: 0 };
}

/* ------------------------------------------------------------------ *
 * 编造的样例（形状是真的，内容是假的）
 * ------------------------------------------------------------------ */

/** 一把 `sk-` 形态的 key。 */
const KEY = "sk-live-9f8e7d6c5b4a3210"; // privacy:allow — 编造的样例
/** 一个 cookie 值：48 个字符，不带点/斜杠/连字符（会话值的样子）。 */
const COOKIE = "0bc1a5c3e5b3a6a1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5"; // privacy:allow — 编造的样例
/** 一个邮箱。 */
const EMAIL = "someone@example.com"; // privacy:allow — 编造的样例
/** 一段 JWT：头.体.签名。 */
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // privacy:allow — 编造的样例
/** 一个账号标识（UUID 形状）。 */
const ACCOUNT = "01a158db-ad50-775e-8c08-6ff8df765b64"; // privacy:allow — 编造的样例

/**
 * 上游风控那种正文：一句话，把这几样都带上。
 *
 * 只带一句正文、不换行 —— 与真上游回的 429 一个形状（CDN 那一层尤其爱这样把
 * 请求里的东西回显回来）。
 */
const LEAKY_BODY = JSON.stringify({
  code: "RATE_LIMITED",
  message:
    `too many requests: cookie acw_tc=${COOKIE}, account ${ACCOUNT}, ` +
    `mail ${EMAIL}, jwt ${JWT}, Authorization: Bearer ${KEY}, retry later`,
});

/* ------------------------------------------------------------------ *
 * 一、客户端那个出口：值抹掉，句子还在
 * ------------------------------------------------------------------ */

section("一、重试用尽：客户端拿到的上游正文里，敏感值都抹掉了");

{
  const refused = upstreamStatusError(429, LEAKY_BODY, "ZCode ", 20);
  const { hint } = await clientHint(refused);

  // 先确认样例里真有这些东西：不然下面那几条「没有出现」可能只是没写过。
  check("样例里带着 key 片段", LEAKY_BODY.includes(KEY), LEAKY_BODY.slice(0, 120));
  check("样例里带着 cookie", LEAKY_BODY.includes(COOKIE), LEAKY_BODY.slice(0, 120));
  check("样例里带着邮箱", LEAKY_BODY.includes(EMAIL), LEAKY_BODY.slice(0, 120));
  check("样例里带着 JWT", LEAKY_BODY.includes(JWT), LEAKY_BODY.slice(0, 120));
  check("样例里带着账号标识", LEAKY_BODY.includes(ACCOUNT), LEAKY_BODY.slice(0, 120));

  check("客户端拿到的 hint 里没有 key 片段", !hint.includes(KEY), hint.slice(0, 400));
  check("客户端拿到的 hint 里没有 cookie 的值", !hint.includes(COOKIE), hint.slice(0, 400));
  check("客户端拿到的 hint 里没有邮箱", !hint.includes(EMAIL), hint.slice(0, 400));
  check("客户端拿到的 hint 里没有 JWT", !hint.includes(JWT), hint.slice(0, 400));
  check("客户端拿到的 hint 里没有账号标识", !hint.includes(ACCOUNT), hint.slice(0, 400));

  // 抹的是值，不是字段名：读的人还得知道上游在说什么。
  check("抹掉的地方留着标记", hint.includes("[已抹去]"), hint.slice(0, 400));
  check("那句话还在（上游说了什么）", hint.includes("too many requests"), hint.slice(0, 400));
  check("cookie 的名字还在", hint.includes("acw_tc="), hint.slice(0, 400));
  check("业务码还在", hint.includes("RATE_LIMITED"), hint.slice(0, 400));
  // 客户端看到的 status 是网关给的那个（upstreamStatusError 说的是 502），上游自己
  // 那个 429 留在错误上：路由要它，客户端不看它。
  const { upstreamStatusOf } = await import("../lib/upstream-status.ts");
  check("上游自己的状态还在错误上", upstreamStatusOf(refused) === 429, String(upstreamStatusOf(refused)));
}

/* ------------------------------------------------------------------ *
 * 二、同一份正文的另一个出口：upstreamStatusError 自己那句 hint
 * ------------------------------------------------------------------ */

section("二、上游拒绝时那一句（`<上游>上游返回 429：…`）也抹");

{
  // 401 那一支不走重试，客户端看到的就是这个错误自带的那句 hint。
  const refused = upstreamStatusError(401, LEAKY_BODY, "WorkBuddy ");
  check("hint 里没有 key 片段", !refused.hint.includes(KEY), refused.hint.slice(0, 400));
  check("hint 里没有 cookie 的值", !refused.hint.includes(COOKIE), refused.hint.slice(0, 400));
  check("hint 里没有邮箱", !refused.hint.includes(EMAIL), refused.hint.slice(0, 400));
  check("hint 里没有 JWT", !refused.hint.includes(JWT), refused.hint.slice(0, 400));
  check("hint 还是那句话（读得懂）", refused.hint.includes("too many requests"), refused.hint.slice(0, 400));
}

/* ------------------------------------------------------------------ *
 * 三、正常正文逐字不变（抹过头与没抹一样是坏的）
 * ------------------------------------------------------------------ */

section("三、没有敏感值的正文：逐字不变");

{
  const plain = "model not found: foo";
  check("纯文本正文逐字不变", scrubForClient(plain) === plain, scrubForClient(plain));

  // 身份：上游自己说的那句「这个模型没有」。
  const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: plain } });
  const refused = upstreamStatusError(429, body, "ZCode ", 20);
  const { hint } = await clientHint(refused);
  check("经过出口之后仍逐字不变", hint === body, hint);

  // 控制组：没有正文时客户端看到的是网关自己编的那一句（那句话不该被抹）。
  const shaped = withUpstreamAnswer(new AuthError("upstream HTTP 429", "", 502), 429, "");
  const control = await clientHint(shaped);
  check("控制组：没有正文时是网关自己那句", control.hint === "上游返回 429。", control.hint);

  // 长正文：日志那边 200 字就截断了，客户端这边不截（4000）。
  const long = "x".repeat(50) + " " + "the upstream said this ".repeat(20);
  check("长正文不被日志那个 200 字的上限截断", scrubForClient(long).length > 200, String(scrubForClient(long).length));
  check("长正文仍受 4000 字的上限", scrubForClient("y ".repeat(5000)).length <= 4000, String(scrubForClient("y ".repeat(5000)).length));

  // 模型名与参数值不是凭据：cookie 那条规则不许把它们抹了。
  const named = "model=claude-3-5-sonnet-20241022 param=deepseek-v4-pro";
  check("模型名不会被当成 cookie 值抹掉", scrubForClient(named) === named, scrubForClient(named));
}

/* ------------------------------------------------------------------ *
 * 四、按形态抹的那几条：同一个函数，两个出口共用
 * ------------------------------------------------------------------ */

section("四、形态规则（key / cookie / 邮箱 / JWT / UUID）");

{
  const lined = `a ${KEY} b acw_tc=${COOKIE} c ${EMAIL} d ${JWT} e ${ACCOUNT} f`;
  const out = scrubForClient(lined);
  check("key 抹掉", !out.includes(KEY), out);
  check("cookie 的值抹掉", !out.includes(COOKIE), out);
  check("邮箱抹掉", !out.includes(EMAIL), out);
  check("JWT 抹掉", !out.includes(JWT), out);
  check("账号标识抹掉", !out.includes(ACCOUNT), out);
  check("句子还读得懂（字母都还在）", /a .* b .* c .* d .* e .* f/.test(out), out);

  // 日志那个出口同一套：给同一个函数，`maxLength` 只是短一点。
  const { scrubForLog } = await import("../lib/log-scrub.ts");
  const forLog = scrubForLog(lined, 4000);
  check("日志那一份抹的是同一套（同一个结果）", forLog === out, forLog);
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

console.log("");
console.log(`${pass} ok, ${fail} fail`);
if (fail > 0) {
  console.log("");
  console.log("客户端拿到的上游正文里有没抹掉的东西 —— 见上面每条 FAIL。");
  process.exit(1);
}
console.log("客户端那份上游正文：值抹掉了，句子还在。");
