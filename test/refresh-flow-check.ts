// test/refresh-flow-check.ts — 换令牌的骨架。
//
//   node --experimental-strip-types test/refresh-flow-check.ts
//
// 离线：不问任何平台。
//
// 骨架在 lib/session.ts 的 refreshSessionFlow：三个平台换令牌的样子一样，
// 差的那几样由各家自己出。这里盯住骨架自己的那几条：
//
//   1. 没到临期就不换（令牌是一次性的，多换一次就多一次被当成重放的机会）。
//   2. 平台拒了 → 这份会话记成死的 → 503。
//   3. 平台没拒绝、只是没成功 → 不记死 → 502（下次还能试）。
//   4. 成了 → 存回新会话。

import fs from "node:fs";

const DATA_DIR = "/tmp/opencode/test-refresh-flow";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

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

const { refreshSessionFlow, deadSession, clearDeadSession, markSessionDead } = await import(
  "../lib/session.ts"
);

interface Fake {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  generation?: number;
}

/** 骨架跑一次：平台怎么答由 answers 给。 */
async function run(
  answers: { ok: boolean; status: number; code: string }[],
  session: Fake | null,
  saved: Fake[],
): Promise<{ error: unknown; result: Fake | null; asked: number }> {
  let asked = 0;
  try {
    const result = await refreshSessionFlow<Fake>({
      id: "session:provider:fake",
      load: () => session,
      bufferMs: 5 * 60_000,
      request: async () => {
        const answer = answers[Math.min(asked, answers.length - 1)];
        asked++;
        return { ok: answer.ok, status: answer.status, code: answer.code, body: { answer } };
      },
      parse: (_body, previous) => ({
        ...previous,
        accessToken: "access_new",
        refreshToken: "refresh_new",
        generation: (previous.generation ?? 0) + 1,
      }),
      refused: (answer) => answer.status === 401 || answer.code === "invalid_grant",
      hint: (code) => `平台拒了（${code}）`,
      save: (next) => saved.push(next),
      label: () => "fake",
      noSession: "没有登录",
    });
    return { error: null, result, asked };
  } catch (e) {
    return { error: e, result: null, asked };
  }
}

console.log("");
console.log("没到临期就不换");

{
  const saved: Fake[] = [];
  // 十分钟后到期：离临期（5 分钟）还远。
  const soon = { accessToken: "a", refreshToken: "r", expiresAtMs: Date.now() + 10 * 60_000 };
  const { result, asked } = await run([{ ok: true, status: 200, code: "ok" }], soon, saved);
  check("没问平台", asked === 0, String(asked));
  check("原样返回", result === soon);
  check("没有存新的", saved.length === 0);
}

{
  // 到临期了：换。
  const saved: Fake[] = [];
  const due = { accessToken: "a", refreshToken: "r", expiresAtMs: Date.now() + 60_000, generation: 3 };
  const { result, asked, error } = await run([{ ok: true, status: 200, code: "ok" }], due, saved);
  check("问了平台", asked === 1, String(asked));
  check("成了", error === null);
  check("是新会话", result?.accessToken === "access_new", JSON.stringify(result));
  check("代次加一", result?.generation === 4, String(result?.generation));
  check("存回新会话", saved.length === 1 && saved[0].accessToken === "access_new");
}

console.log("");
console.log("平台拒了：这份会话就死了");

{
  clearDeadSession("session:provider:fake");
  const saved: Fake[] = [];
  const due = { accessToken: "a", refreshToken: "r", expiresAtMs: Date.now() + 60_000 };
  const { error, asked } = await run([{ ok: false, status: 401, code: "invalid_grant" }], due, saved);
  check("报错了", error !== null);
  check("是 503", (error as { status?: number }).status === 503, String((error as { status?: number }).status));
  check("问了平台", asked === 1, String(asked));
  check("会话被记成死的", deadSession("session:provider:fake") !== null, String(deadSession("session:provider:fake")));
  check("没存新的", saved.length === 0);

  // 死着的会话不再问平台。
  const again = await run([{ ok: true, status: 200, code: "ok" }], due, saved);
  check("不再问平台", again.asked === 0, String(again.asked));
  check("还是 503", (again.error as { status?: number }).status === 503);
}

{
  // 401 也算拒了。
  clearDeadSession("session:provider:fake");
  const saved: Fake[] = [];
  const due = { accessToken: "a", refreshToken: "r", expiresAtMs: Date.now() + 60_000 };
  const { error } = await run([{ ok: false, status: 401, code: "whatever" }], due, saved);
  check("401 也记死", deadSession("session:provider:fake") !== null);
  check("是 503", (error as { status?: number }).status === 503);
}

console.log("");
console.log("平台没拒绝、只是没成功：不记死");

{
  clearDeadSession("session:provider:fake");
  const saved: Fake[] = [];
  const due = { accessToken: "a", refreshToken: "r", expiresAtMs: Date.now() + 60_000 };
  const { error, asked } = await run([{ ok: false, status: 500, code: "boom" }], due, saved);
  check("报了错", error !== null);
  check("是 502", (error as { status?: number }).status === 502, String((error as { status?: number }).status));
  check("问了平台", asked === 1, String(asked));
  check("没有记死（下次还能试）", deadSession("session:provider:fake") === null, String(deadSession("session:provider:fake")));
  check("没存新的", saved.length === 0);
}

console.log("");
console.log("没有会话");

{
  clearDeadSession("session:provider:fake");
  const saved: Fake[] = [];
  const { error, asked } = await run([{ ok: true, status: 200, code: "ok" }], null, saved);
  check("报错了", error !== null);
  check("是 503", (error as { status?: number }).status === 503);
  check("没问平台", asked === 0, String(asked));
  const hint = (error as { hint?: string }).hint ?? "";
  check("说了怎么登录", hint.length > 0, hint);
}

console.log("");
console.log("操作者清了记号，又能试一次");

{
  const saved: Fake[] = [];
  const due = { accessToken: "a", refreshToken: "r", expiresAtMs: Date.now() + 60_000 };
  markSessionDead("session:provider:fake", "之前拒了");
  const dead = await run([{ ok: true, status: 200, code: "ok" }], due, saved);
  check("死着的时候不问平台", dead.asked === 0, String(dead.asked));

  clearDeadSession("session:provider:fake");
  const alive = await run([{ ok: true, status: 200, code: "ok" }], due, saved);
  check("清了就又能试", alive.asked === 1, String(alive.asked));
  check("而且成了", alive.error === null);
}

console.log("");
console.log("平台那边卡住：到点收手，不重试");

{
  clearDeadSession("session:provider:fake");
  const saved: Fake[] = [];
  const due = { accessToken: "a", refreshToken: "r", expiresAtMs: Date.now() + 60_000 };
  let asked = 0;
  const started = Date.now();
  let error: unknown = null;
  try {
    await refreshSessionFlow<Fake>({
      id: "session:provider:fake",
      load: () => due,
      bufferMs: 5 * 60_000,
      // 平台那边不答应：一直挂着。
      request: async (_session, signal) => {
        asked++;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
      parse: (_body, previous) => previous,
      refused: () => false,
      hint: () => "平台拒了",
      save: (next) => saved.push(next),
      label: () => "fake",
      noSession: "没有登录",
      timeoutMs: 200,
    });
  } catch (e) {
    error = e;
  }
  const took = Date.now() - started;
  check("到点就收手", took < 3000, `${took}ms`);
  check("报了超时", error !== null && String((error as Error).message).includes("timed out"), String(error));
  check("是 503", (error as { status?: number }).status === 503);
  check("只问了一次（不重试）", asked === 1, String(asked));
  check("没有记死（下一轮还能试）", deadSession("session:provider:fake") === null, String(deadSession("session:provider:fake")));
  check("没存新的", saved.length === 0);
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
