// test/selection-check.ts — 共用包（lib/router/selection.ts）的语义。
//
//   node --experimental-strip-types test/selection-check.ts
//
// 离线：不碰网络，只测「挑一个候选」的规矩：
//   1. single 只试权重最大的那个，失败就是失败，不换；
//   2. fallback 按权重降序依次试，遇到「不可用」才降级；
//   3. 请求本身的问题不降级（degradable 说不行就立刻抛）；
//   4. 权重相同时保持传入次序。

import { select, SelectionStop } from "../lib/router/selection.ts";

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

/** 一个候选：记下自己试过没有，然后成功或者失败。 */
function candidate(
  id: string,
  weight: number,
  outcome: "ok" | Error,
  tried: string[],
): { id: string; weight: number; run: () => Promise<string> } {
  return {
    id,
    weight,
    run: async () => {
      tried.push(id);
      if (outcome === "ok") return `answer from ${id}`;
      throw outcome;
    },
  };
}

console.log("");
console.log("single");

{
  const tried: string[] = [];
  const value = await select({
    strategy: "single",
    candidates: [
      candidate("light", 1, "ok", tried),
      candidate("heavy", 5, "ok", tried),
    ],
  });
  check("只试了权重最大的那个", tried.length === 1 && tried[0] === "heavy", tried.join(","));
  check("答案是它给的", value === "answer from heavy", value);
}

{
  const tried: string[] = [];
  const boom = new Error("the upstream said no");
  let caught: unknown = null;
  try {
    await select({
      strategy: "single",
      candidates: [candidate("first", 5, boom, tried), candidate("second", 1, "ok", tried)],
    });
  } catch (e) {
    caught = e;
  }
  check("失败就是失败", caught === boom, String(caught));
  check("没有试下一个", tried.length === 1 && tried[0] === "first", tried.join(","));
}

{
  const tried: string[] = [];
  const boom = new Error("the upstream said no");
  let caught: any = null;
  try {
    await select({
      strategy: "single",
      candidates: [candidate("first", 5, boom, tried)],
      failure: () => new Error("nothing answered"),
    });
  } catch (e) {
    caught = e;
  }
  check("错误由调用方塑形", caught?.message === "nothing answered", String(caught?.message));
}

console.log("");
console.log("fallback");

{
  const tried: string[] = [];
  const value = await select({
    strategy: "fallback",
    candidates: [
      candidate("first", 3, "ok", tried),
      candidate("second", 2, "ok", tried),
      candidate("third", 1, "ok", tried),
    ],
  });
  check("第一个就成功了", tried.length === 1 && tried[0] === "first", tried.join(","));
  check("答案是它给的", value === "answer from first", value);
}

{
  const tried: string[] = [];
  const value = await select({
    strategy: "fallback",
    candidates: [
      candidate("heavy", 9, new Error("no credit"), tried),
      candidate("middle", 5, "ok", tried),
      candidate("light", 1, "ok", tried),
    ],
    degradable: () => true,
  });
  check("不可用的换下一个", tried.join(",") === "heavy,middle", tried.join(","));
  check("答案是第二个给的", value === "answer from middle", value);
}

{
  const tried: string[] = [];
  const boom = new Error("the request is wrong");
  let caught: unknown = null;
  try {
    await select({
      strategy: "fallback",
      candidates: [candidate("first", 9, boom, tried), candidate("second", 5, "ok", tried)],
      degradable: () => false,
    });
  } catch (e) {
    caught = e;
  }
  check("请求本身的问题不降级", caught === boom, String(caught));
  check("没有试下一个", tried.length === 1, tried.join(","));
}

{
  const tried: string[] = [];
  let caught: any = null;
  try {
    await select({
      strategy: "fallback",
      candidates: [
        candidate("first", 9, new Error("no credit"), tried),
        candidate("second", 5, new Error("no credit"), tried),
      ],
      degradable: () => true,
      failure: (lastError, triedIds) =>
        new Error(`nothing answered: ${triedIds.join(",")} / ${(lastError as Error).message}`),
    });
  } catch (e) {
    caught = e;
  }
  check("都试过了才报错", caught?.message === "nothing answered: first,second / no credit", String(caught?.message));
}

{
  const tried: string[] = [];
  let caught: any = null;
  try {
    await select({
      strategy: "fallback",
      candidates: [candidate("first", 9, new Error("no credit"), tried)],
      degradable: () => true,
    });
  } catch (e) {
    caught = e;
  }
  check("没有塑形时抛最后一个错误", caught?.message === "no credit", String(caught?.message));
}

{
  // The root route's invariant: without a rule every failure moves on.
  const tried: string[] = [];
  let caught: any = null;
  try {
    await select({
      strategy: "fallback",
      candidates: [
        candidate("first", 9, new Error("no credit"), tried),
        candidate("second", 5, new Error("the request is wrong"), tried),
      ],
    });
  } catch (e) {
    caught = e;
  }
  check("没有 degradable 时每个错误都往下走", tried.join(",") === "first,second", tried.join(","));
  check("抛的是最后一个错误", caught?.message === "the request is wrong", String(caught?.message));
}

console.log("");
console.log("次序");

{
  const tried: string[] = [];
  await select({
    strategy: "fallback",
    candidates: [
      candidate("a", 5, "ok", tried),
      candidate("b", 5, "ok", tried),
      candidate("c", 5, "ok", tried),
    ],
  });
  check("权重相同时保持传入次序", tried.join(",") === "a", tried.join(","));
}

{
  const tried: string[] = [];
  await select({
    strategy: "fallback",
    candidates: [
      candidate("a", 1, "ok", tried),
      candidate("b", 9, "ok", tried),
      candidate("c", 5, "ok", tried),
    ],
  });
  check("按权重降序", tried.join(",") === "b", tried.join(","));
}

console.log("");
console.log("每次尝试都报一声");

{
  const tried: string[] = [];
  const seen: string[] = [];
  await select({
    strategy: "fallback",
    candidates: [
      candidate("first", 9, new Error("no credit"), tried),
      candidate("second", 5, "ok", tried),
    ],
    onAttempt: (c, error) => seen.push(`${c.id}:${error ? "failed" : "ok"}`),
  });
  check("成功与失败都报了", seen.join(",") === "first:failed,second:ok", seen.join(","));
}

console.log("");
console.log("答复已经开始就不换了");

{
  const tried: string[] = [];
  const boom = new Error("the stream broke");
  let caught: unknown = null;
  try {
    await select({
      strategy: "fallback",
      candidates: [
        {
          id: "first",
          weight: 9,
          run: async () => {
            tried.push("first");
            throw new SelectionStop(boom);
          },
        },
        candidate("second", 5, "ok", tried),
      ],
    });
  } catch (e) {
    caught = e;
  }
  check("抛的是原来的错误", caught === boom, String(caught));
  check("没有试下一个", tried.length === 1, tried.join(","));
}

console.log("");
console.log("单一策略：答复开始了就不换了");

{
  const tried: string[] = [];
  const boom = new Error("the stream broke");
  let caught: unknown = null;
  try {
    await select({
      strategy: "single",
      candidates: [
        {
          id: "first",
          weight: 9,
          run: async () => {
            tried.push("first");
            throw new SelectionStop(boom);
          },
        },
        candidate("second", 5, "ok", tried),
      ],
    });
  } catch (e) {
    caught = e;
  }
  check("抛的是原来的错误", caught === boom, String(caught));
  check("没有试下一个", tried.length === 1, tried.join(","));
}

console.log("");
console.log("不认识的策略");

{
  let caught: any = null;
  try {
    await select({ strategy: "typo" as any, candidates: [candidate("only", 1, "ok", [])] });
  } catch (e) {
    caught = e;
  }
  check("报错，不静默按降级跑", caught instanceof Error, String(caught?.message));
  check("说的是不认识的策略", String(caught?.message).includes("unknown selection strategy"), String(caught?.message));
}

console.log("");
console.log("没有候选");

{
  let caught: any = null;
  try {
    await select({ strategy: "fallback", candidates: [] });
  } catch (e) {
    caught = e;
  }
  check("报的是错", caught instanceof Error, String(caught));
}

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
