// test/zcode-system-check.ts — the `system` array the gateway sends to ZCode.
//
//   node --experimental-strip-types test/zcode-system-check.ts
//
// Offline: no request goes to ZCode. The reference is the official client's
// own prompt (docs/zcode/system-prompt-3.16.3.json, kept on the machine that
// recorded it) and what the live upstream accepted on 2026-11-07
// (docs/zcode/system-segments-probe-2026-11-07.md).
//
// The last block runs the same assertions against the old behaviour — the
// caller's `system` forwarded as-is — and requires them to fail: a test that
// passes either way would not notice the day the rewrite disappeared.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Json } from "../lib/json.ts";

// The ZCode session layer reads config while the module is evaluated, so the
// import happens after the data directory is set (same reason as
// test/zcode-headers-check.ts).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-system-"));
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { zcodeBody } = await import("../lib/zcode/transport.ts");
const { OFFICIAL_SEGMENT_1, OFFICIAL_SEGMENT_2, zcodeSystem, toolNamesOf } = await import(
  "../lib/zcode/system.ts"
);
const { ZCODE_MODELS, zcodeEffortFor } = await import("../lib/zcode/models.ts");

const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) process.exitCode = 1;
};

const session: Json = {
  token: "jwt_test",
  provider: "zai",
  deviceId: "11111111-2222-3333-4444-555555555555",
  generation: 1,
  loginAtMs: Date.now(),
  expiresAtMs: Date.now() + 3600_000,
};

/** A string no official segment contains, so its occurrences can be counted. */
const MARKER = "CALLER-MARKER-7f3a";

/** The caller's own prompt, the way an agent sends it. */
const CALLER = `${MARKER} You are pi. Answer in Chinese.`;

/** Tools a third-party agent sends, in Anthropic shape. */
const TOOLS = [
  { name: "bash", description: "", input_schema: {} },
  { name: "read", description: "", input_schema: {} },
  { name: "edit", description: "", input_schema: {} },
  { name: "write", description: "", input_schema: {} },
  { name: "grep", description: "", input_schema: {} },
];

/** The request body a client sends, before the gateway rewrites anything. */
const requestBody = (): Json => ({
  model: "GLM-5.3-Flash",
  max_tokens: 16,
  system: CALLER,
  tools: TOOLS,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
});

/** Every text of a `system` array, joined — what the upstream reads as one prompt. */
const allText = (system: unknown): string => {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((block) => String(block?.text ?? "")).join("\n");
};

/**
 * The `system` array of a body, or `[]` when it is not one.
 *
 * A wrong shape is a FAIL with a readable detail, not a TypeError halfway
 * through the block: a crashed test says nothing about what the body held.
 */
const systemArrayOf = (body: Json): Json[] => {
  const system = (body as Json)["system"];
  return Array.isArray(system) ? (system as Json[]) : [];
};

/** Tools the caller sends, lowercase, as the tool note has to name them. */
const HARNESS_TOOLS = ["write", "bash", "read", "grep"];

/**
 * Whether `text` names exactly these tools, in any order.
 *
 * Order is the source constant's declaration order, not a contract, so the
 * names are compared as a set: a run of comma-separated lowercase names that
 * holds the same set as `tools` counts. Written this way instead of matching
 * the note's wording so a reworded sentence does not fail the assertion and a
 * dropped tool name still does.
 */
const namesTools = (text: string, tools: readonly string[]): boolean => {
  const want = [...tools].sort().join(",");
  for (const run of text.match(/[a-z][a-z_]*(?:, [a-z][a-z_]*)+/g) ?? []) {
    if (run.split(", ").sort().join(",") === want) return true;
  }
  return false;
};

/**
 * The acceptance assertions, named so the counter-proof can say which of them
 * the old behaviour breaks.
 *
 *   a1  exactly three segments, each `{type:"text", text}`
 *   a2  the first segment is the official sentence, verbatim
 *   a3  the second segment is the trimmed official one
 *   a4  the caller's prompt appears once, in the third segment, with the tool note
 *   a5  the second segment is 1584 characters, the length the upstream accepted
 */
function audit(system: unknown): string[] {
  const failed: string[] = [];
  const blocks = Array.isArray(system) ? system : [];

  const shapesOk =
    blocks.length === 3 &&
    blocks.every((block) => block?.type === "text" && typeof block?.text === "string");
  if (!shapesOk) failed.push("a1-segments");

  if (blocks[0]?.text !== "You are ZCode, an interactive coding agent") failed.push("a2-segment1");

  const second = String(blocks[1]?.text ?? "");
  const dropped = [
    "::code-comment",
    "M:\\agents-data",
    "window.zcode",
    "Gen UI",
    "visualize skill",
    "untrusted_gen_ui_state",
    "### Interactive views",
    "### Inline Code Comments",
  ];
  const kept = [
    "You are an interactive ZCode agent",
    "IMPORTANT: Assist with authorized security testing",
    "# Harness",
    "# ZCode Desktop Context",
    "### Files & URLs",
    "Reference code as `file_path:line_number`",
  ];
  const secondOk = dropped.every((s) => !second.includes(s)) && kept.every((s) => second.includes(s));
  if (!secondOk) failed.push("a3-segment2");

  const third = String(blocks[2]?.text ?? "");
  const occurrences = allText(blocks).split(MARKER).length - 1;
  const thirdOk =
    blocks.length === 3 &&
    third.includes(MARKER) &&
    occurrences === 1 &&
    third.includes("lowercase") &&
    namesTools(third, HARNESS_TOOLS);
  if (!thirdOk) failed.push("a4-caller-once");

  // The trim was measured (probe run S3): the upstream recognises a prompt of
  // this length, so one character added or removed is a different prompt
  if (second.length !== 1584) failed.push("a5-segment2-length");

  return failed;
}

console.log("");
console.log("zcodeBody 出去的 system：三段");

{
  const body = zcodeBody(requestBody(), session, { model: "GLM-5.3-Flash" });
  const system = (body as Json)["system"];
  check("是数组", Array.isArray(system), typeof system);
  check("恰好 3 段", Array.isArray(system) && system.length === 3, String((system as unknown[])?.length));
  check(
    "每段都是 {type:'text', text:string}",
    Array.isArray(system) &&
      system.every((block: Json) => block.type === "text" && typeof block.text === "string"),
    JSON.stringify(system),
  );
  check(
    "调用方原来的 system 字符串没有原样留一份",
    JSON.stringify(system) !== JSON.stringify(CALLER),
  );
  check("验收断言全部通过", audit(system).length === 0, audit(system).join(","));
}

console.log("");
console.log("段 1：官方原句，逐字");

{
  check("42 字符", OFFICIAL_SEGMENT_1.length === 42, String(OFFICIAL_SEGMENT_1.length));
  check(
    "内容就是那一句",
    OFFICIAL_SEGMENT_1 === "You are ZCode, an interactive coding agent",
    OFFICIAL_SEGMENT_1,
  );
  const body = zcodeBody(requestBody(), session, { model: "GLM-5.3-Flash" });
  check("zcodeBody 发的第一段就是它", (body as Json)["system"]?.[0]?.text === OFFICIAL_SEGMENT_1);
}

console.log("");
console.log("段 2：官方原文，裁掉两节");

{
  const dropped = [
    "::code-comment",
    "M:\\agents-data",
    "window.zcode",
    "Gen UI",
    "visualize skill",
    "untrusted_gen_ui_state",
  ];
  for (const s of dropped) {
    check(`不含 ${s}`, !OFFICIAL_SEGMENT_2.includes(s));
  }
  const kept = [
    "You are an interactive ZCode agent that helps users with software engineering tasks.",
    "IMPORTANT: Assist with authorized security testing",
    "# Harness",
    "# ZCode Desktop Context",
    "### Files & URLs",
    "Reference code as `file_path:line_number`",
  ];
  for (const s of kept) {
    check(`含 ${s}`, OFFICIAL_SEGMENT_2.includes(s));
  }
  // The measured trim: the upstream accepted this exact text (probe run S3),
  // so the length is part of the fingerprint and a deliberate change only.
  check("1584 字符（实测通过的那一份）", OFFICIAL_SEGMENT_2.length === 1584, String(OFFICIAL_SEGMENT_2.length));
  check("开头那个换行还在", OFFICIAL_SEGMENT_2.startsWith("\n"), JSON.stringify(OFFICIAL_SEGMENT_2.slice(0, 3)));
}

console.log("");
console.log("段 3：调用方自己的 + 工具名说明");

{
  const body = zcodeBody(requestBody(), session, { model: "GLM-5.3-Flash" });
  const raw = (body as Json)["system"];
  const system = systemArrayOf(body);
  check("是数组", Array.isArray(raw), typeof raw);
  const third = String(system[2]?.text ?? "");
  check("带调用方的原文", third.includes(CALLER), third.slice(0, 80));
  check("带工具名说明的标题", third.includes("# Tool names"), third.slice(-200));
  check("写的是本 harness 真有的工具", namesTools(third, HARNESS_TOOLS), third.slice(-200));
  check("点名了本 harness 没有的工具", third.includes("Skill"), third.slice(-200));

  const whole = allText(system);
  check("调用方原文只出现一次", whole.split(MARKER).length - 1 === 1, String(whole.split(MARKER).length - 1));
}

console.log("");
console.log("调用方没给 system：还是 3 段");

{
  const body = zcodeBody({ model: "GLM-5.3-Flash", messages: [] } as Json, session, {
    model: "GLM-5.3-Flash",
  });
  const raw = (body as Json)["system"];
  const system = systemArrayOf(body);
  check("是数组", Array.isArray(raw), typeof raw);
  check("3 段", system.length === 3, String(system.length));
  check("段 3 不是空的", String(system[2]?.text ?? "").length > 0);
  check("段 3 是工具名说明", String(system[2]?.text ?? "").includes("# Tool names"));
}

console.log("");
console.log("调用方的 system 是块数组：归一成文本");

{
  const blocks = [
    { type: "text", text: `${MARKER} first block` },
    { type: "text", text: "second block" },
  ];
  const body = zcodeBody({ model: "GLM-5.3-Flash", system: blocks, messages: [] } as Json, session, {
    model: "GLM-5.3-Flash",
  });
  const raw = (body as Json)["system"];
  const system = systemArrayOf(body);
  check("是数组", Array.isArray(raw), typeof raw);
  const third = String(system[2]?.text ?? "");
  check("还是 3 段", system.length === 3, String(system.length));
  check("两块都在段 3", third.includes("first block") && third.includes("second block"), third.slice(0, 120));
  check(
    "顺序不变，中间隔一个空行",
    third.includes(`${MARKER} first block\n\nsecond block`),
    JSON.stringify(third.slice(0, 120)),
  );
  check("原文只出现一次", allText(system).split(MARKER).length - 1 === 1);
}

console.log("");
console.log("思考档位：映射之后必须落在模型认的清单里");

{
  // The model always thinks, so `medium` is a 400 (code 1210): whatever an
  // agent asks for, what goes out has to be one the model accepts.
  //
  // Membership alone is not enough — an implementation that ignores its input
  // and always answers `allowed[0]` passes it — so the mapping itself is
  // pinned. The expected values follow from the ladder in `zcodeEffortFor`
  // (`disabled, minimal, low, medium, high, max`) and the catalog's list
  // (`low, high, max`): an allowed want goes out unchanged; `medium` is one
  // step from `low` and one from `high`, and the tie goes to the deeper one;
  // `disabled` and `minimal` are nearest `low`. Both catalog entries carry the
  // same list today — a model with a different list needs its own row here.
  const expected: Record<string, string> = {
    disabled: "low",
    minimal: "low",
    low: "low",
    medium: "high",
    high: "high",
    max: "max",
  };
  const wrong: string[] = [];
  for (const model of ZCODE_MODELS) {
    for (const want of Object.keys(expected)) {
      const got = zcodeEffortFor(model.id, want);
      if (got !== expected[want]) wrong.push(`${model.id}:${want}->${got} (want ${expected[want]})`);
    }
  }
  check("合法的原样发出，不合法的按梯子就近且同距离取深", wrong.length === 0, wrong.join(","));

  const wanted = ["disabled", "minimal", "low", "medium", "high", "max", "", "whatever"];
  const outside: string[] = [];
  for (const model of ZCODE_MODELS) {
    for (const want of wanted) {
      const got = zcodeEffortFor(model.id, want);
      if (!model.efforts.includes(got)) outside.push(`${model.id}:${want}->${got}`);
    }
  }
  check("都在模型认的档位里", outside.length === 0, outside.join(","));
}

console.log("");
console.log("工具名：两种方言都认得");

{
  check("Anthropic 的 {name}", toolNamesOf([{ name: "bash" }]).join(",") === "bash");
  check(
    "OpenAI 的 {function:{name}}",
    toolNamesOf([{ type: "function", function: { name: "read_file" } }]).join(",") === "read_file",
  );
  check("没有 tools 就是空的", toolNamesOf(undefined).length === 0);
  check("空数组也是空的", toolNamesOf([]).length === 0);
}

console.log("");
console.log("反证：原样直传会被这些断言拦下");

{
  // What the gateway used to do: hand the caller's `system` to the upstream
  // untouched. Every acceptance assertion has to notice.
  const before = requestBody();
  const passed = [...audit(before.system)];
  check("段数那条红", passed.includes("a1-segments"), passed.join(","));
  check("段 1 那条红", passed.includes("a2-segment1"), passed.join(","));
  check("段 2 那条红", passed.includes("a3-segment2"), passed.join(","));
  check("段 3 那条红", passed.includes("a4-caller-once"), passed.join(","));
  check("段 2 长度那条红", passed.includes("a5-segment2-length"), passed.join(","));

  // The other way to get it wrong: the official three, then the caller's own
  // as a fourth segment — the 3012 seen on the live upstream (probe run S2).
  const four = [
    { type: "text", text: OFFICIAL_SEGMENT_1 },
    { type: "text", text: OFFICIAL_SEGMENT_2 },
    { type: "text", text: "official third" },
    { type: "text", text: CALLER },
  ];
  check("四段也红", audit(four).includes("a1-segments"), audit(four).join(","));

  // The rewrite itself still passes the same function.
  const good = systemArrayOf(zcodeBody(requestBody(), session, { model: "GLM-5.3-Flash" }) as Json);
  check("改写后是绿的", audit(good).length === 0, audit(good).join(","));
  check("zcodeSystem 单独调用也是绿的", audit(zcodeSystem(CALLER, ["write", "bash", "read", "grep"])).length === 0);

  // One character more or less in segment 2 is a different prompt (the trim of
  // probe run S3 is measured), so string-level edits have to be noticed too —
  // a3 alone looks for substrings and would miss an added or removed character.
  const mutated = good.map((block, index) =>
    index === 1 ? { ...block, text: `${String(block?.text ?? "")}x` } : block,
  );
  const mutatedFailed = audit(mutated);
  check("段 2 多一个字符也红", mutatedFailed.includes("a5-segment2-length"), mutatedFailed.join(","));
}

console.log("");
