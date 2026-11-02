// test/stream-budget-check.ts — 一个请求的等待预算、客户端走后的结算、请求本身的错、半截 gzip。
//
//   node --experimental-strip-types test/stream-budget-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 覆盖：
//   1. 等待预算按请求算：两个 Qoder target 都在排队，加起来不超过一份预算；
//   2. 限流等待中客户端断开：立刻停，不等满上游说的那几秒；
//   3. 客户端走了之后的 success() 不清账号原来的冷却；
//   4. 413 不再「立刻停」，400 提到 model 时仍换 target，400/422 请求本身的错照旧停；
//   5. ZCode 的 400 带着上游自己的状态（主路由靠它判断）；
//   6. cliFetch：gzip 答复读到一半上游断了，以错误结束，不挂住。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stream-budget-"));
process.env.BUDDY_DATA_DIR = tmp;

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = ""): void {
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

/** 跑一段代码，把它打出来的警告收下来。 */
async function warningsDuring<T>(run: () => T | Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

/* ------------------------------------------------------------------ *
 * 假上游：ZCode 的 400，以及一个半截的 gzip 答复
 * ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/half-gzip")) {
    const full = zlib.gzipSync(Buffer.from("x".repeat(200_000)));
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    // 只给前一半，然后连接直接没了。
    res.write(full.subarray(0, Math.floor(full.length / 2)), () => {
      setTimeout(() => res.socket?.destroy(), 50);
    });
    return;
  }
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages: field required" } }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.ZCODE_BASE_URL = base;

const { LimitError } = await import("../lib/qoder/transport.ts");
const { qoderWithRetry } = await import("../lib/router/upstreams/qoder.ts");
const { RATE_WAIT_BUDGET_MS, waitOnBudget } = await import("../lib/router/rate-budget.ts");
const { settlement } = await import("../lib/router/upstreams/policy.ts");
const { ClientClosedError } = await import("../lib/router/request-life.ts");
const { isRequestFault } = await import("../lib/router/request-fault.ts");
const { setCooldown, cooldownUntil } = await import("../lib/cooldown.ts");
const { withUpstreamStatus, upstreamStatusOf } = await import("../lib/upstream-status.ts");
const { AuthError } = await import("../lib/credential.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setSecret, closeStore } = await import("../lib/store.ts");
const { cliFetch } = await import("../lib/http.ts");

try {
  section("1. 等待预算按请求算：两个 Qoder target 都在排队");
  {
    // 预算已经用掉了大半：第一个 target 还能等一次（1 秒），第二次就等不起了；
    // 第二个 target 用的是同一本账，一次也等不起。
    const life = { rateWait: { spentMs: RATE_WAIT_BUDGET_MS - 1500 } };
    const sends = { a: 0, b: 0 };
    const queued = () => new LimitError("qoder model is queued (HTTP 429)", "排队", 1);
    const began = Date.now();
    let errA: unknown = null;
    try {
      await qoderWithRetry(async () => {
        sends.a++;
        throw queued();
      }, 10, false, life);
    } catch (e) {
      errA = e;
    }
    let errB: unknown = null;
    try {
      await qoderWithRetry(async () => {
        sends.b++;
        throw queued();
      }, 10, false, life);
    } catch (e) {
      errB = e;
    }
    const elapsed = Date.now() - began;
    check("第一个 target 抛出原来的排队错误", errA instanceof LimitError, String(errA));
    check("第二个 target 也抛出原来的排队错误", errB instanceof LimitError, String(errB));
    check("第一个 target 只重试了一次（预算只够一次）", sends.a === 2, String(sends.a));
    check("第二个 target 没有等（同一份预算已经用完）", sends.b === 1, String(sends.b));
    check("账上记的等待不超过一份预算", life.rateWait.spentMs <= RATE_WAIT_BUDGET_MS, String(life.rateWait.spentMs));
    check("总共只等了一秒左右", elapsed < 2500, `${elapsed}ms`);
  }

  section("2. 限流等待中客户端断开：立刻停");
  {
    const controller = new AbortController();
    const life = { signal: controller.signal, rateWait: { spentMs: 0 } };
    let sends = 0;
    setTimeout(() => controller.abort(new ClientClosedError()), 150);
    const began = Date.now();
    let caught: unknown = null;
    try {
      await qoderWithRetry(async () => {
        sends++;
        throw new LimitError("qoder model is queued (HTTP 403)", "排队", 10);
      }, 5, false, life);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - began;
    check("抛的是客户端走了", caught instanceof ClientClosedError, String(caught));
    check("没等满 10 秒（一秒内就停了）", elapsed < 1000, `${elapsed}ms`);
    check("没有再打上游", sends === 1, String(sends));
    check("等了多久照样记账", life.rateWait.spentMs > 0 && life.rateWait.spentMs < 1000, String(life.rateWait.spentMs));

    // 客户端早就走了：一次也不等，直接停。
    const gone = new AbortController();
    gone.abort(new ClientClosedError());
    let early: unknown = null;
    try {
      await waitOnBudget(5000, { signal: gone.signal });
    } catch (e) {
      early = e;
    }
    check("已经走了的客户端：不等", early instanceof ClientClosedError, String(early));
  }

  section("3. 客户端走了之后的 success() 不清冷却");
  {
    const until = Date.now() + 600_000;
    setCooldown("acct-gone", until, "earlier failure");
    const controller = new AbortController();
    const settle = settlement(controller.signal);
    settle.bind("acct-gone", "test");
    controller.abort(new ClientClosedError());
    settle.success();
    check("冷却还在", cooldownUntil("acct-gone") === until, String(cooldownUntil("acct-gone")));

    setCooldown("acct-done", until, "earlier failure");
    const done = settlement(new AbortController().signal);
    done.bind("acct-done", "test");
    done.success();
    check("对照：客户端还在时 success() 清掉冷却", cooldownUntil("acct-done") === null, String(cooldownUntil("acct-done")));
  }

  section("4. 什么算「请求本身的错」");
  {
    const upstream = (status: number, hint: string) =>
      withUpstreamStatus(new AuthError(`upstream HTTP ${status}`, `上游返回 ${status}：${hint}`, 502), status);
    check("400（不提模型）：停", isRequestFault(upstream(400, "messages: field required")));
    check("422：停", isRequestFault(upstream(422, "cannot process")));
    check("413（上下文太长）：不停，交给下一个 target", !isRequestFault(upstream(413, "prompt is too long")));
    check("400 提到 model：不停", !isRequestFault(upstream(400, "model glm-x does not exist")));
    check("400 提到模型：不停", !isRequestFault(upstream(400, "模型不存在")));
    check("网关自己的 400（没有上游状态）：不停", !isRequestFault(new AuthError("no such model", "x", 400)));
  }

  section("5. ZCode 的 400 带着上游自己的状态");
  {
    const made = addAccount({ platform: "zcode" });
    const id = made.id ?? "zcode";
    setSecret(`session:provider:${id}`, "session", { token: "zcode-test-token", deviceId: "dev-test", expiresAtMs: 0 });
    const { zcodeChat } = await import("../lib/zcode/transport.ts");
    let caught: any = null;
    const { warnings } = await warningsDuring(async () => {
      try {
        await zcodeChat({ model: "glm-5.3", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, { providerId: id });
      } catch (e) {
        caught = e;
      }
    });
    check("抛了错", caught !== null);
    check("错误上有上游的 400", caught?.upstreamStatus === 400 && upstreamStatusOf(caught) === 400, JSON.stringify(caught));
    check("客户端看到的还是网关的 502", caught?.status === 502, String(caught?.status));
    check("判成请求本身的错", isRequestFault(caught));
    check("上游的正文进了日志", warnings.some((w) => w.includes("messages: field required")), warnings.join(" | "));
  }

  section("6. cliFetch：gzip 读到一半上游断了");
  {
    const res = await cliFetch(`${base}/half-gzip`);
    check("头是 200", res.status === 200, String(res.status));
    const outcome = await Promise.race([
      res.text().then(
        (text) => ({ kind: "ok" as const, detail: `${text.length} chars` }),
        (e: unknown) => ({ kind: "error" as const, detail: String(e) }),
      ),
      new Promise<{ kind: "hang"; detail: string }>((resolve) =>
        setTimeout(() => resolve({ kind: "hang", detail: "5 秒还没结束" }), 5000),
      ),
    ]);
    check("以错误结束（不是挂住，也不是当成完整答复）", outcome.kind === "error", `${outcome.kind}: ${outcome.detail}`);
  }
} finally {
  server.close();
  closeStore();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
