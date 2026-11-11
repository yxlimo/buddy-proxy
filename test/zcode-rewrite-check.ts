// test/zcode-rewrite-check.ts — the `::code-comment{...}` rewrite.
//
//   node --experimental-strip-types test/zcode-rewrite-check.ts
//
// Offline: nothing here talks to ZCode, or to anything else.
//
// Five groups:
//
//   1. the whole-text rewrite, one expected string per case, compared verbatim
//   2. chunk invariance: the same cases pushed in pieces must spell exactly what
//      the whole-text rewrite spelled — a character at a time, three at a time,
//      and cut at every position in turn
//   3. text without a directive is not harmed by the streaming path
//   4. the invariance test, run again against a pass-through rewriter, has to
//      fail — on every case whose rewrite is not a no-op, not just one —
//      otherwise group 2 would pass on a rewriter that does nothing
//   5. the ceiling: an opener that never closes is given up on, not buffered
//      forever
//   6. the held tail at the very end of the text: `flush()` hands it out — the
//      text ends in something that could have become an opener and never did,
//      which used to be re-sliced forever and hang the whole answer
//   7. fenced code blocks: what the model is showing comes out byte for byte,
//      whatever the fence looks like, and the answers around it are still
//      rewritten
//   8. a fixed-sequence sweep of fences, directives and whitespace, pushed in
//      every chunking, with both sides read back by a second implementation of
//      the fence rule: what is inside a fence comes out byte for byte, and what
//      is outside one really is rewritten
//
// Group 4 re-runs the same invariance assertions with `codeCommentStream`
// replaced by a rewriter that emits what it is given. That is the only way to
// show group 2 reacts to the streaming path rather than to the whole-text one.

import { rewriteCodeComments, codeCommentStream } from "../lib/zcode/rewrite.ts";
import type { StreamRewriter } from "../lib/zcode/rewrite.ts";

const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) process.exitCode = 1;
};

const show = (text: string) => JSON.stringify(text);

// ── 1. the whole-text rewrite ─────────────────────────────────────────────

/** `::code-comment` written out, so the cases below read as the model wrote them */
const D = "::code-comment";

/** The fenced markers, as values: a template literal cannot hold them */
const TICKS = "```";
const TWO_TICKS = "``";
const ONE_TICK = "`";
const TILDES = "~~~";
const FOUR_TICKS = "````";

/**
 * The answer that made the fence tracking necessary: a model demonstrating the
 * syntax, which it writes inside a fence the way it writes any literal text
 */
const SHOWING_THE_SYNTAX =
  "Look:\n\n" + `${TICKS}markdown\n${D}{title="示例" body="语法演示" file="/x.ts"}\n${TICKS}` + "\n\nThat is the syntax.";

const LONG_UNCLOSED = `${D}{title="` + "x".repeat(9000);

const CASES: Array<{ name: string; input: string; want?: string }> = [
  {
    name: "标准单条",
    input:
      `${D}{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." ` +
      `file="/path/to/foo.ts" start=10 end=11 priority=2}`,
    want:
      "> **[P2] Off-by-one**\n>\n> Loop iterates past the end when length is 0.\n>\n" +
      "> `foo.ts:10-11`",
  },
  {
    // start=end is one line, and priority is the only rank in the title
    name: "带 priority 且 start=end",
    input:
      `${D}{title="Rename the loop index" body="It shadows the outer i." ` +
      `file="src/app.ts" start=7 end=7 priority=1}`,
    want: "> **[P1] Rename the loop index**\n>\n> It shadows the outer i.\n>\n> `app.ts:7`",
  },
  {
    // no title: the first sentence of the body is the label, the body stays whole
    name: "缺 title",
    input: `${D}{body="The cache is never cleared. Add a reset." file="lib/cache.ts" start=3}`,
    want:
      "> **The cache is never cleared**\n>\n> The cache is never cleared. Add a reset.\n>\n" +
      "> `cache.ts:3`",
  },
  {
    // no file: no location line at all
    name: "缺 file",
    input: `${D}{title="[P0] Data loss" body="The write is not flushed."}`,
    want: "> **[P0] Data loss**\n>\n> The write is not flushed.",
  },
  {
    // only `end`: the official spec says end defaults to start, so it is one line
    name: "只有 end",
    input: `${D}{title="Narrow the type" body="It is never null here." file="types.ts" end=9}`,
    want: "> **Narrow the type**\n>\n> It is never null here.\n>\n> `types.ts:9`",
  },
  {
    // a `}` inside the quotes is part of the body, not the end of the directive
    name: "引号里含 }",
    input:
      `${D}{title="Guard the map" body="Return early when {a: 1} has no key} really." ` +
      `file="a.ts"}`,
    want: "> **Guard the map**\n>\n> Return early when {a: 1} has no key} really.\n>\n> `a.ts`",
  },
  {
    // single quotes for the body, and `\"` inside both values is just a quote
    name: "引号里含转义引号",
    input:
      `${D}{title="Say \\"no\\"" body='It prints \\"ok\\" twice.' file="b.ts" start=1 end=2}`,
    want: '> **Say "no"**\n>\n> It prints "ok" twice.\n>\n> `b.ts:1-2`',
  },
  {
    // two directives on consecutive lines: one blank line between the blocks
    name: "两条指令",
    input:
      `${D}{title="A" body="First." file="a.ts"}\n` + `${D}{title="B" body="Second." file="b.ts"}`,
    want:
      "> **A**\n>\n> First.\n>\n> `a.ts`\n\n> **B**\n>\n> Second.\n>\n> `b.ts`",
  },
  {
    // a directive is only a directive with its brace; this is prose about one
    name: "句中出现但没有 {",
    input: `See the ${D} directive in the prompt, and the ${D} one after it.`,
    want: `See the ${D} directive in the prompt, and the ${D} one after it.`,
  },
  {
    name: "未闭合",
    input: `Text before\n${D}{title="Never closed" body="The answer stopped here`,
    want: `Text before\n${D}{title="Never closed" body="The answer stopped here`,
  },
  {
    name: "超长未闭合",
    input: LONG_UNCLOSED,
    want: LONG_UNCLOSED,
  },
  {
    name: "空文本",
    input: "",
    want: "",
  },
  {
    // The text stops in the middle of an opener that never becomes one. Nothing
    // may wait for a next chunk that is not coming
    name: "结尾是半个开头",
    input: `Done.\n\n::code-com`,
    want: `Done.\n\n::code-com`,
  },
  {
    // A fenced block is the model showing text, not writing it: rewriting what
    // it printed would put words in its mouth. Byte for byte, nothing else
    name: "围栏里的指令",
    input: SHOWING_THE_SYNTAX,
    want: SHOWING_THE_SYNTAX,
  },
  {
    name: "~~~ 围栏",
    input: `Before\n\n${TILDES}\n${D}{title="示例" body="语法演示"}\n${TILDES}\n\nAfter`,
  },
  {
    // The info string is text too, and a directive written there is part of the
    // fence line rather than a card
    name: "带 info string 的围栏",
    input: `Text\n\n${TICKS}js // ${D}{title="T" body="B"}\nlet a = 1;\n${TICKS}\n\nDone`,
  },
  {
    // A fence the model never closed runs to the end of the answer: everything
    // after it is still the model's own bytes
    name: "未闭合围栏",
    input: `Text\n\n${TICKS}\n${D}{title="T" body="B"}\nstill inside`,
  },
  {
    // Four backticks are closed by four, so the three inside stay content
    name: "四条反引号围住三条",
    input:
      `Head\n\n${FOUR_TICKS}\n${D}{title="T" body="B"}\n${TICKS}\n` +
      `${D}{title="T" body="B"}\n${FOUR_TICKS}\n\nTail`,
  },
];

// A case with no `want` is one that has to come out as it went in
const EXPECTED = CASES.map(({ name, input, want }) => ({ name, input, want: want ?? input }));

console.log("── 1. 整段改写 ──");
for (const { name, input, want } of EXPECTED) {
  const got = rewriteCodeComments(input);
  check(name, got === want, `want ${show(want)}\n     got  ${show(got)}`);
}

// ── 2 & 4. chunk invariance ───────────────────────────────────────────────

/** Pushes `input` through `make()` in the given piece sizes and returns what came out */
function streamed(input: string, sizes: number[], make: () => StreamRewriter): string {
  const stream = make();
  let out = "";
  let at = 0;
  for (const size of sizes) {
    out += stream.push(input.slice(at, at + size));
    at += size;
  }
  out += stream.push(input.slice(at));
  return out + stream.flush();
}

/** Every way of holding `input` in two pieces, one cut position at a time */
function cutEverywhere(input: string, make: () => StreamRewriter): string[] {
  const made: string[] = [];
  for (let cut = 0; cut <= input.length; cut++) {
    made.push(streamed(input, [cut], make));
  }
  return made;
}

/**
 * Invariance itself, one entry per case and chunking so group 4 can run it with
 * another rewriter and report which entries broke
 *
 * `cases` is what group 4 narrows: a case that comes out as it went in cannot
 * tell a working rewriter from one that does nothing
 */
function invariance(
  make: () => StreamRewriter,
  cases: Array<{ name: string; input: string }> = EXPECTED,
): Array<{ name: string; ok: boolean; detail: string }> {
  const entries: Array<{ name: string; ok: boolean; detail: string }> = [];
  for (const { name, input } of cases) {
    const want = rewriteCodeComments(input);
    const byChar = streamed(input, Array<number>(input.length).fill(1), make);
    entries.push({
      name: `逐字符 ${name}`,
      ok: byChar === want,
      detail: `want ${show(want)}\n     got  ${show(byChar)}`,
    });
    const byThree = streamed(input, Array<number>(Math.ceil(input.length / 3)).fill(3), make);
    entries.push({
      name: `每 3 字符 ${name}`,
      ok: byThree === want,
      detail: `want ${show(want)}\n     got  ${show(byThree)}`,
    });
    // every cut position, except on the 9 KB case where it would be 9 KB runs of nothing new
    if (input.length <= 400) {
      const bad = cutEverywhere(input, make).filter((got) => got !== want);
      entries.push({
        name: `任意位置切两块 ${name}`,
        ok: bad.length === 0,
        detail: `${bad.length} of ${input.length + 1} cuts differ, first ${show(bad[0])}`,
      });
    }
  }
  return entries;
}

console.log("");
console.log("── 2. 分块不变性 ──");
for (const { name, ok, detail } of invariance(codeCommentStream)) check(`不变性 ${name}`, ok, detail);

// ── 3. text without a directive ───────────────────────────────────────────

const PLAIN = [
  "# Release notes\n",
  "\n",
  "A table the model wrote:\n",
  "\n",
  "| file | lines | note |\n",
  "| --- | --- | --- |\n",
  "| `a.ts` | 10-11 | off by one |\n",
  "\n",
  "A code block with colons in it:\n",
  "\n",
  "```ts\n",
  "const open = (x: string) => `::${x}`;\n",
  "  // indented on purpose\n",
  "\t// and a tab\n",
  "```\n",
  "\n",
  "Ends with a brace, no directive: { ok }\n",
].join("");

console.log("");
console.log("── 3. 不含指令的文本 ──");
{
  const whole = codeCommentStream();
  const got = whole.push(PLAIN) + whole.flush();
  check("整段推入", got === PLAIN, `got ${show(got)}`);

  const byLine = codeCommentStream();
  let lines = "";
  for (const chunk of PLAIN.split(/(?<=\n)/)) lines += byLine.push(chunk);
  lines += byLine.flush();
  check("逐行推入", lines === PLAIN, `got ${show(lines)}`);

  const byChar = streamed(PLAIN, Array<number>(PLAIN.length).fill(1), codeCommentStream);
  check("逐字符推入", byChar === PLAIN, `got ${show(byChar)}`);
}

// ── 4. the reverse proof ──────────────────────────────────────────────────

/** A rewriter that does nothing, to prove group 2 notices when the streaming path is gone */
const passthrough = (): StreamRewriter => ({
  push: (chunk: string) => chunk,
  flush: () => "",
});

console.log("");
console.log("── 4. 反证：直通增量器 ──");
/**
 * The cases whose whole-text rewrite changes something
 *
 * The reverse proof runs over these and only these: a case that comes out as it
 * went in — no directive at all, a directive inside a fence, one that never
 * closed — is handled *correctly* by a rewriter that does nothing, so a pass
 * there says nothing either way. Narrowing the list is what lets the assertion be
 * "every one of them red" instead of "at least one"
 */
const REWRITABLE = EXPECTED.filter(({ input, want }) => want !== input);
{
  // The same assertions against a rewriter that emits what it is given, over
  // every case that does rewrite something. If these entries came from the
  // whole-text rewrite alone they would all pass here too, and group 2 would not
  // be watching the streaming path at all
  const reversed = invariance(passthrough, REWRITABLE);
  const broken = reversed.filter((entry) => !entry.ok);
  const survived = reversed.filter((entry) => entry.ok);
  for (const entry of survived.slice(0, 3)) console.log(`     直通下竟然通过：${entry.name}`);
  console.log(`直通增量器下的失败项：${broken.length} / ${reversed.length}`);
  check(
    `反证覆盖了 ${REWRITABLE.length} 条会改写的用例（每条 3 种分块）`,
    REWRITABLE.length > 0 && reversed.length === REWRITABLE.length * 3,
    `${REWRITABLE.length} 条用例 × 3 = ${REWRITABLE.length * 3}，实际 ${reversed.length}`,
  );
  check(
    `直通下 ${REWRITABLE.length} 条会改写的用例全部变红`,
    broken.length === reversed.length,
    `${reversed.length} 条里有 ${survived.length} 条通过：${survived.map((entry) => entry.name).join(", ")}`,
  );
}

// ── 5. the ceiling ────────────────────────────────────────────────────────

console.log("");
console.log("── 5. 缓冲上限 ──");
{
  const many = `${D}{`.repeat(4000);
  const started = Date.now();
  const got = streamed(LONG_UNCLOSED, Array<number>(LONG_UNCLOSED.length).fill(1), () =>
    codeCommentStream(),
  );
  const elapsed = Date.now() - started;
  check("超长未闭合逐字符不卡", got === LONG_UNCLOSED && elapsed < 5000, `${elapsed}ms`);
  check("只有开头的重复也不卡", rewriteCodeComments(many) === many);
}

console.log("");
// ── 6. the held tail at the end of the text ──────────────────────────────
console.log("── 6. 结尾扣住的尾巴 ──");
{
  // A held tail at the end of the text is where the danger is: `drain(final)`
  // has no next chunk to decide on, and a rewriter that keeps waiting for one
  // both loses the tail and spins forever — a synchronous loop, so the event
  // loop it runs on never gets a chance to time it out
  const TAILS: Array<{ name: string; chunks: string[]; want: string }> = [
    { name: "整个开头的一半", chunks: ["Done.\n\n::code-com"], want: "Done.\n\n::code-com" },
    { name: "分开推入", chunks: ["Done.\n\n", "::code-", "com"], want: "Done.\n\n::code-com" },
    { name: "只有一个冒号", chunks: ["Done. ", ":"], want: "Done. :" },
    { name: "两个冒号", chunks: ["Done. ", ":", ":"], want: "Done. ::" },
    {
      name: "差一个花括号",
      chunks: ["Done.\n\n::code-comment"],
      want: "Done.\n\n::code-comment",
    },
  ];
  for (const { name, chunks, want } of TAILS) {
    const stream = codeCommentStream();
    const started = Date.now();
    let got = "";
    for (const chunk of chunks) got += stream.push(chunk);
    got += stream.flush();
    const elapsed = Date.now() - started;
    check(`flush 交出来了：${name}`, got === want, `want ${show(want)} got ${show(got)}`);
    // A spin does not look slow, it never returns: the timing is what makes
    // that difference a red line instead of a hung test
    check(`没有原地打转：${name}`, elapsed < 2000, `${elapsed}ms`);
  }

  // The other end of the same rule: when the last thing out was a complete
  // directive, nothing is held and flush() says so
  const finished = codeCommentStream();
  finished.push(`${D}{title="A" body="B."}`);
  check("结尾是完整的指令：flush 是空的", finished.flush() === "");
}

console.log("");
// ── 7. fenced code blocks ──────────────────────────────────────────────
console.log("── 7. 围栏代码块 ──");
{
  const outside = `${D}{title="A" body="First." file="a.ts"}`;
  const shown = `${TICKS}\n${D}{title="T" body="B"}\n${TICKS}`;

  // Indented code blocks are deliberately not tracked: four spaces is also how a
  // paragraph, a list item and a quote start, and a fence read where there is
  // none would stop rewriting ordinary answers
  for (const [name, input] of [
    ["四空格缩进不处理", `    ${D}{title="T" body="B"}`],
    ["tab 缩进不处理", `\t${D}{title="T" body="B"}`],
  ] as const) {
    const got = rewriteCodeComments(input);
    check(name, got.includes("> **T**") && !got.includes(D), show(got));
  }

  // Inline code is single backticks, and that is not a fence: the directive in it
  // is still rewritten, as it was before fences were tracked at all
  {
    const input = `Run \`${D}{title="T" body="B"}\` now`;
    const got = rewriteCodeComments(input);
    check("行内代码照旧改写", got.includes("> **T**") && !got.includes(D), show(got));
  }

  // Both sides of one answer: the gate is a filter, not an off switch
  {
    const input = `${outside}\n\n${shown}\n\n${outside}`;
    const got = rewriteCodeComments(input);
    check(
      "围栏两侧的指令仍改写",
      got.split("> **A**").length - 1 === 2 && got.includes(`${D}{title="T" body="B"}`),
      show(got),
    );
  }

  // A fence arrives split across chunks whenever the network does, and its own
  // characters are the most likely place to cut: every position inside the run
  for (const [name, input, fence] of [
    ["三个反引号中间切两块", SHOWING_THE_SYNTAX, TICKS],
    ["~~~ 中间切两块", `Look:\n\n${TILDES}\n${D}{title="T" body="B"}\n${TILDES}\n\nDone.`, TILDES],
    ["四条反引号中间切两块", `A\n\n${FOUR_TICKS}\n${D}{title="T" body="B"}\n${FOUR_TICKS}\n\nB`, FOUR_TICKS],
  ] as const) {
    const want = rewriteCodeComments(input);
    const start = input.indexOf(fence);
    const bad: string[] = [];
    for (let cut = start; cut <= start + fence.length; cut++) {
      const got = streamed(input, [cut], codeCommentStream);
      if (got !== want) bad.push(`cut ${cut}: ${show(got)}`);
    }
    check(name, bad.length === 0, bad.join(" | "));
  }

  // An opening run that never reaches three is not a fence. Held while the next
  // chunk could still finish it, handed out on flush
  for (const { name, chunks, want } of [
    { name: "结尾一个反引号", chunks: ["Done.\n\n", ONE_TICK], want: `Done.\n\n${ONE_TICK}` },
    { name: "结尾两个反引号", chunks: ["Done.\n\n", TWO_TICKS], want: `Done.\n\n${TWO_TICKS}` },
    { name: "结尾恰好三个反引号", chunks: ["a\n\n", TICKS], want: `a\n\n${TICKS}` },
    { name: "结尾三个波浪号", chunks: ["a\n\n", TILDES], want: `a\n\n${TILDES}` },
  ]) {
    const stream = codeCommentStream();
    let got = "";
    for (const chunk of chunks) got += stream.push(chunk);
    got += stream.flush();
    check(`flush 交出来了：${name}`, got === want, `want ${show(want)} got ${show(got)}`);
  }

  // An answer that ends inside an unclosed fence holds nothing back: the block is
  // the model's bytes and the stream is over
  {
    const input = `Text\n\n${TICKS}\n${D}{title="T" body="B"}`;
    const stream = codeCommentStream();
    let got = "";
    for (const chunk of input) got += stream.push(chunk);
    check("未闭合围栏结束后没有残留", stream.flush() === "" && got === input, show(got));
  }
}

// ── 8. fenced blocks across arbitrary chunkings ───────────────────────────

/** `::code-comment{` — the opener, as the tests below look for it */
const OPEN = `${D}{`;

/** A fixed-sequence generator, so a failing answer is the same answer next run */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Whether two lists hold the same strings, in the same order, byte for byte */
const sameList = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((item, at) => item === right[at]);

/**
 * The answer split into fenced blocks and the stretches between them, read by
 * walking the lines here
 *
 * A second reading of the same rule, written for what it produces rather than
 * for how the rewriter thinks: the two agreeing over a whole sweep is the
 * evidence, and a shared implementation would agree with itself. A `code`
 * stretch runs from the opening fence line through the closing one, the fence
 * lines included — they are as much of what the model printed as the body is
 */
function fencedParts(text: string): { code: string[]; plain: string[] } {
  const code: string[] = [];
  const plain: string[] = [];
  /** The open block: its fence character, and the length a closing run has to reach */
  let open: { char: string; len: number } | null = null;
  let inCode = false;
  let run: string[] = [];
  const endRun = () => {
    if (!run.length) return;
    (inCode ? code : plain).push(run.join(""));
    run = [];
  };
  // Split after each newline, so joining a run back gives the bytes it was read from
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, "");
    if (open) {
      run.push(line);
      const end = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(bare);
      if (end && end[1][0] === open.char && end[1].length >= open.len) {
        open = null;
        endRun();
        inCode = false;
      }
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(bare);
    if (marker) {
      endRun();
      inCode = true;
      open = { char: marker[1][0], len: marker[1].length };
    }
    run.push(line);
  }
  // An unclosed fence runs to the end of the text
  endRun();
  return { code, plain };
}

console.log("");
console.log("── 8. 围栏在任意分块下 ──");
{
  /** Fences, whole directives, and the whitespace a model puts between them */
  const PARTS = [
    `${D}{title="A" body="B"}`,
    `${D}{body="B" file="/a.ts" start=3}`,
    TICKS,
    FOUR_TICKS,
    TILDES,
    TWO_TICKS,
    ONE_TICK,
    "~",
    "\n",
    "\n\n",
    " ",
    "  ",
    "    ",
    "\t",
    `${TICKS}ts\n`,
    `${TICKS}markdown\n`,
    `\n${TICKS}\n`,
    `\n${TILDES}\n`,
    "x",
    "code()",
    "\r\n",
    "#",
  ];
  const next = sequence(20260215);
  const pick = () => PARTS[Math.floor(next() * PARTS.length)];
  const sweep = (input: string, sizes: number[]) => {
    const stream = codeCommentStream();
    let out = "";
    let at = 0;
    for (const size of sizes) {
      out += stream.push(input.slice(at, at + size));
      at += size;
    }
    return out + stream.push(input.slice(at)) + stream.flush();
  };

  const differing: string[] = [];
  /** Inputs whose fenced stretches did not come out byte for byte */
  const changedInside: string[] = [];
  /** Inputs that still had a directive outside a fence after the rewrite */
  const keptOutside: string[] = [];
  let blocks = 0;
  /** Inputs that had a directive outside a fence to begin with */
  let witnessed = 0;
  for (let n = 0; n < 1500; n++) {
    let input = "";
    for (let part = 1 + Math.floor(next() * 8); part > 0; part--) input += pick();
    const whole = rewriteCodeComments(input);
    const byChar = sweep(input, Array<number>(input.length).fill(1));
    const byThree = sweep(input, Array<number>(Math.ceil(input.length / 3)).fill(3));
    const sizes: number[] = [];
    for (let left = input.length; left > 0; ) {
      const size = 1 + Math.floor(next() * 4);
      sizes.push(size);
      left -= size;
    }
    const ragged = sweep(input, sizes);
    const before = fencedParts(input);
    const after = fencedParts(whole);
    // What the model showed comes back byte for byte. The fenced stretches are
    // compared as a list rather than searched for as substrings: a body that came
    // out truncated is still "included", and so is one that moved
    //
    // Read before anything can `continue` past it: an answer whose chunkings
    // disagree is reported once, and skipping the fence checks for it would leave
    // those checks shielding whatever broke the chunking
    blocks += before.code.length;
    if (!sameList(before.code, after.code)) changedInside.push(input);
    // The other direction: what is outside a fence is rewritten. A gate that read
    // every opener as a fence and never closed it would keep the whole answer
    // verbatim, and the check above would not notice — nothing inside a block
    // would have changed either way
    if (before.plain.some((stretch) => stretch.includes(OPEN))) witnessed++;
    if (after.plain.some((stretch) => stretch.includes(OPEN))) keptOutside.push(input);
    if (byChar !== whole || byThree !== whole || ragged !== whole) differing.push(input);
  }
  check(
    "任意分块下与整段一致",
    differing.length === 0,
    `${differing.length} 条不一致，第一条 ${show(differing[0])}`,
  );
  check(
    `围栏里的内容逐字节不变（${blocks} 段）`,
    changedInside.length === 0,
    `${changedInside.length} 条被改动，第一条 ${show(changedInside[0])}`,
  );
  check(
    `围栏外的指令都被改写了（扫到 ${witnessed} 条围栏外带指令的输入）`,
    witnessed > 0 && keptOutside.length === 0,
    keptOutside.length
      ? `${keptOutside.length} 条还留着原文，第一条 ${show(keptOutside[0])}`
      : "扫过的输入里没有一条在围栏外带指令，这个方向没被验证",
  );

  // The rule from group 7 that is easiest to lose, and the one the comment on
  // `fenceGate` argues for: a fence the model never closed runs to the end of the
  // text, so everything after it stays as the model wrote it. Named on its own
  // here rather than left to the sweep, so a change to that rule is a red line
  // and not a difference nobody looks at
  {
    const input = CASES.find((item) => item.name === "未闭合围栏")?.input ?? "";
    const whole = rewriteCodeComments(input);
    const before = fencedParts(input);
    const after = fencedParts(whole);
    check(
      "未闭合围栏：围栏内段逐字节未变",
      before.code.length === 1 && sameList(before.code, after.code),
      `before ${show(before.code.join(""))}\n     after  ${show(after.code.join(""))}`,
    );
    check(
      "未闭合围栏：那段里确实有指令（这个方向不是空跑）",
      before.code.join("").includes(OPEN),
      show(before.code.join("")),
    );
  }
}

console.log("");
console.log(process.exitCode ? "FAIL" : "全部通过");
