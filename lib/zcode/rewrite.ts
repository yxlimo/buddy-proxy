// lib/zcode/rewrite.ts — ZCode's `::code-comment{...}` directive, as Markdown.
//
// The directive belongs to ZCode's own prompt (docs/system-prompts/zcode.md,
// `### Inline Code Comments`) and to nothing else: an agent calling this
// gateway has never heard of it, so it reaches the person reading the answer as
// the literal text `::code-comment{title="…`, quotes and braces and all. What
// the ZCode desktop app would have drawn as a card becomes a blockquote —
// label, explanation, location, the order a review comment reads in:
//
//   ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when
//   length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}
//
//   > **[P2] Off-by-one**
//   >
//   > Loop iterates past the end when length is 0.
//   >
//   > `foo.ts:10-11`
//
// A directive is only drawn from text that reads back cleanly: every attribute
// a `name="value"` pair with its quotes closed, nothing but whitespace before the
// closing `}`, nothing after it that still looks like an attribute, and the line
// numbers whole. A real answer came back with the brace written early —
// `…explaining why."} file="input.js" start=1 end=1 priority=1}` — and a reader
// that stopped at the first `}` drew a card out of half a directive: a title with
// its opening quote still in it, a body cut where the next quote fell, a location
// read off the wreckage. A card drawn from half a directive is worse than the
// directive, so when the text does not read back cleanly the whole thing stays as
// the model wrote it, byte for byte, and the reader gets what it actually said
//
// Two entry points, because the answer arrives both ways: whole (a buffered
// reply, a recorded body) and in pieces (SSE splits the directive anywhere —
// `::code-com` then `ment{title="…` then `" }`). `codeCommentStream()` holds
// back only what could still turn into a directive, so the rest of the answer
// is not delayed behind it.
//
// Everything outside a directive is the model's own Markdown and comes out
// byte for byte: output that differs from the input except for the directives
// themselves would be a rewrite nobody asked for.
//
// A fenced code block is the model *showing* text rather than writing it: the
// directive inside one is an example of the syntax, so rewriting it would put
// words in the model's mouth. Both entry points therefore read the answer
// through `fenceGate()` first and only look for directives in what is left.
//
// Two boundaries, both because a fence read where there is none would stop
// rewriting real answers: indented code blocks (four spaces or a tab at the line
// head) are not tracked, and neither is inline code (single backticks) — a
// directive in either is rewritten, exactly as it was before fences were read at
// all.

/** The directive's name. ZCode also prints other `::x{}` forms, which are not ours */
const TAG = "::code-comment";

/** `::code-comment{` — the opener, and the tail a stream is allowed to hold */
const OPEN = `${TAG}{`;

/**
 * How much of one directive is worth buffering, opener included
 *
 * A `}` inside a quoted body is legal, so an unterminated directive is not
 * distinguishable from a very long one until the text ends. Without a ceiling a
 * single stray `::code-comment{` would swallow the rest of the answer and hold
 * it until the client gave up
 */
const MAX_DIRECTIVE = 8192;

/**
 * How wide a whitespace-only gap between two comments may be and still count as
 * "no separator", which gets replaced by one blank line
 *
 * Capped so a long run of blank lines after a comment is not held back waiting
 * for the next thing — past this the gap is plainly the author's own spacing
 */
const MAX_GAP = 4096;

/** A rank the model already wrote into its title (`[P2]`, `【P2】`); a second one would be noise */
const RANK_IN_TITLE = /[[【]\s*P\d+\s*[\]】]/i;

const isWhitespace = (text: string) => /^[ \t\r\n]*$/.test(text);

const isSpaceChar = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

/** The leftmost `::code-comment{` at or after `from`, or -1 */
function findDirectiveIn(text: string, from: number): number {
  let at = text.indexOf(TAG, from);
  while (at >= 0) {
    if (text[at + TAG.length] === "{") return at;
    at = text.indexOf(TAG, at + TAG.length);
  }
  return -1;
}

/** The characters an attribute name is made of, and the only thing that may follow a value */
const isNameChar = (c: string) => /[A-Za-z0-9_-]/.test(c);

/**
 * How long a word after the closing `}` still counts as a stray attribute
 *
 * The stream has to answer "stray attribute or prose?" before it can hand the
 * card over, so the question has to settle within a fixed lookahead. Past this a
 * word is prose, which is what a model writes after a directive anyway
 */
const MAX_STRAY_NAME = 32;

/** What a `::code-comment{` turned out to be */
type Directive =
  /** Read cleanly: a card can be drawn, and the directive runs to `end` */
  | { kind: "ok"; attrs: Map<string, string>; end: number }
  /** The text stops before the question can be answered: more may still arrive */
  | { kind: "open" }
  /** Not something a card can be drawn from: the bytes stay as the model wrote them */
  | { kind: "bad" };

/** The two failures, carrying nothing, so every exit can return one of them */
const UNFINISHED = { kind: "open" } as const;
const UNREADABLE = { kind: "bad" } as const;

/** One attribute value: what it holds, where it stops, or why it cannot be read */
type Value = { kind: "ok"; text: string; next: number } | typeof UNFINISHED | typeof UNREADABLE;

/**
 * The whole number an attribute holds, `null` when it holds anything else, and
 * `undefined` when the model did not write it at all
 */
const writtenInt = (value: string | undefined): number | null | undefined => {
  if (value === undefined) return undefined;
  const text = value.trim();
  return /^\d+$/.test(text) ? Number(text) : null;
};

/**
 * Whether the lines a directive names are lines a card can point at
 *
 * A `start` that is not a whole number, or an `end` before it, makes the location
 * wrong rather than the explanation — and a location read off the wrong numbers is
 * exactly the half-a-card this file exists to prevent
 */
function placeable(attrs: Map<string, string>): boolean {
  const start = writtenInt(attrs.get("start"));
  const end = writtenInt(attrs.get("end"));
  if (start === null || end === null) return false;
  return start === undefined || end === undefined || end >= start;
}

/**
 * One attribute value, read strictly: the quotes that open also close, and a
 * quote inside the value is either escaped or doubled
 *
 * Strict because a model that loses track of its own quotes writes a value whose
 * end cannot be told from its middle — `body="he said "stop" here"` reads three
 * ways and none of them is what the model meant. Bare values stay allowed:
 * `start=10` and `priority=high` are both unambiguous as written
 */
function readValue(text: string, at: number, ceiling: number, final: boolean): Value {
  const quote = text[at];
  let i = at;
  let value = "";
  if (quote === '"' || quote === "'") {
    i++;
    for (;;) {
      if (i >= text.length) return final ? UNREADABLE : UNFINISHED;
      if (i > ceiling) return UNREADABLE;
      const c = text[i];
      if (c === "\\") {
        // A backslash makes the next character ordinary, quoted or not, so a
        // path or a quote inside a value survives it
        if (i + 1 >= text.length) return final ? UNREADABLE : UNFINISHED;
        value += text[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) {
        // A doubled quote is the value's own quote, the way CSV spells it, so the
        // delimiters are the pair around it and not this one
        if (text[i + 1] === quote) {
          value += quote;
          i += 2;
          continue;
        }
        return { kind: "ok", text: value, next: i + 1 };
      }
      value += c;
      i++;
    }
  }
  for (;;) {
    if (i >= text.length) return final ? UNREADABLE : UNFINISHED;
    if (i > ceiling) return UNREADABLE;
    const c = text[i];
    if (isSpaceChar(c) || c === "}") return { kind: "ok", text: value, next: i };
    // A quote in a bare value is the model opening a string and losing the
    // opening quote, which leaves no way to say where the value stops
    if (c === '"' || c === "'") return UNREADABLE;
    if (c === "\\") {
      if (i + 1 >= text.length) return final ? UNREADABLE : UNFINISHED;
      value += text[i + 1];
      i += 2;
      continue;
    }
    value += c;
    i++;
  }
}

/**
 * The decision at the closing `}`, which has to be made on what comes after it
 *
 * A model that closes the brace early writes `…why."}` and then goes on with
 * `file="input.js" start=1 end=1 priority=1}`: the brace is in the wrong place and
 * everything after it was meant to be inside. Prose after a directive is ordinary
 * (`…} form out of it`), so what makes the tail a stray attribute is a name and an
 * `=`, and only on the same line — a newline ends the directive either way
 */
function settled(text: string, at: number, attrs: Map<string, string>, final: boolean): Directive {
  let i = at;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  if (i >= text.length) {
    // Whether this line continues into a `file=` is not known yet, and a
    // directive that turns out to be the broken shape must not be drawn before
    // that is settled: the stream and the whole text have to agree
    if (!final) return UNFINISHED;
  } else if (text[i] !== "\n" && text[i] !== "\r") {
    let nameEnd = i;
    while (nameEnd < text.length && nameEnd - i < MAX_STRAY_NAME && isNameChar(text[nameEnd])) nameEnd++;
    if (nameEnd > i) {
      let after = nameEnd;
      while (after < text.length && (text[after] === " " || text[after] === "\t")) after++;
      if (after >= text.length) {
        if (!final) return UNFINISHED;
      } else if (text[after] === "=" && nameEnd - i < MAX_STRAY_NAME) {
        return UNREADABLE;
      }
    }
  }
  if (!placeable(attrs)) return UNREADABLE;
  return { kind: "ok", attrs, end: at };
}

/**
 * One directive whose opener ends at `from`, read strictly
 *
 * Strict all the way to the closing brace and past it: every attribute is a
 * `name=value` pair, a quoted value closes, a bare value is a word, nothing but
 * whitespace stands between the last value and the `}`, and the line numbers are
 * whole. `final` says whether more text can still arrive, which is the difference
 * between "not decided yet" and "the model did not write a directive here"
 */
function parseDirective(text: string, from: number, final: boolean): Directive {
  const attrs = new Map<string, string>();
  // The ceiling is on the directive's own length: `from` points into the middle
  // of an answer, and the text around it is not what is being measured
  const ceiling = from + MAX_DIRECTIVE - OPEN.length;
  let i = from;
  for (;;) {
    while (i < text.length && isSpaceChar(text[i])) i++;
    if (i >= text.length) return final ? UNREADABLE : UNFINISHED;
    if (i > ceiling) return UNREADABLE;
    if (text[i] === "}") return settled(text, i + 1, attrs, final);
    let nameEnd = i;
    while (nameEnd < text.length && isNameChar(text[nameEnd])) nameEnd++;
    // No name here is the model losing the shape: a second `=`, a quote, a colon
    if (nameEnd === i) return UNREADABLE;
    if (nameEnd >= text.length) return final ? UNREADABLE : UNFINISHED;
    if (nameEnd > ceiling) return UNREADABLE;
    const key = text.slice(i, nameEnd).toLowerCase();
    i = nameEnd;
    while (i < text.length && isSpaceChar(text[i])) i++;
    if (i >= text.length) return final ? UNREADABLE : UNFINISHED;
    // An attribute without a value is not a shape this syntax has, so it is not
    // one the rewrite guesses at
    if (text[i] !== "=") return UNREADABLE;
    i++;
    while (i < text.length && isSpaceChar(text[i])) i++;
    if (i >= text.length) return final ? UNREADABLE : UNFINISHED;
    const value = readValue(text, i, ceiling, final);
    if (value.kind !== "ok") return value;
    attrs.set(key, value.text);
    i = value.next;
  }
}

/** The first sentence of a paragraph, which is the label a titleless comment gets */
function firstSentence(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    let end = -1;
    if (c === "\n" || c === "。" || c === "！" || c === "？") end = i;
    // A stop that ends a sentence, not one inside `e.g.` or `1.5`
    else if (c === "." || c === "!" || c === "?") {
      const next = text[i + 1];
      if (next === undefined || isSpaceChar(next)) end = i;
    }
    if (end > 0 && text.slice(0, end).trim()) return text.slice(0, end).trim();
  }
  return text.trim();
}

/** `foo.ts:10-11` — the file by its last segment, the range only when it says one */
function location(attrs: Map<string, string>): string {
  const file = (attrs.get("file") ?? "").trim();
  if (!file) return "";
  const name = file.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? file;
  // Both are whole numbers by the time a card is drawn: `placeable` rejected
  // whatever was not
  const lines = [writtenInt(attrs.get("start")), writtenInt(attrs.get("end"))].filter(
    (line): line is number => typeof line === "number",
  );
  if (lines.length === 0) return name;
  const lo = Math.min(...lines);
  const hi = Math.max(...lines);
  return lo === hi ? `${name}:${lo}` : `${name}:${lo}-${hi}`;
}

/** A path inside backticks, with the delimiters Markdown needs when the path has one of its own */
function codeSpan(text: string): string {
  if (!text.includes("`")) return `\`${text}\``;
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `\`\`${pad}${text}${pad}\`\``;
}

const quoted = (text: string) =>
  text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

/**
 * One directive as a blockquote, or an empty string
 *
 * Empty is a real answer: a directive with neither title nor body carries
 * nothing to read, and leaving the bare `::code-comment{` in place is the one
 * outcome the rewrite exists to prevent
 */
function renderComment(attrs: Map<string, string>): string {
  const body = (attrs.get("body") ?? "").trim();
  const given = (attrs.get("title") ?? "").trim();
  if (!given && !body) return "";
  let title = (given || firstSentence(body)).replace(/\s*\n\s*/g, " ").trim();
  const rank = (attrs.get("priority") ?? "").trim();
  // The official attribute is 0-3; anything else is not a rank we know how to draw
  if (/^[0-3]$/.test(rank) && !RANK_IN_TITLE.test(title)) title = `[P${rank}] ${title}`;
  const parts = [`> **${title}**`];
  if (body) parts.push(quoted(body));
  const ref = location(attrs);
  if (ref) parts.push(`> ${codeSpan(ref)}`);
  return parts.join("\n>\n");
}

/**
 * Every `::code-comment{...}` in one stretch of plain text rendered as
 * Markdown, everything else left alone
 *
 * Two comments in a row are separated by one blank line whatever stood between
 * them: a directive on its own line has no visible body, so the blocks would
 * otherwise run together. `afterBlock` carries that "a comment just went out"
 * state in and back out, because the stretch that follows a comment may not be
 * in the same piece of text
 */
function rewritePlainText(
  text: string,
  afterBlockIn: boolean,
): { out: string; afterBlock: boolean } {
  const out: string[] = [];
  let emitted = 0;
  let from = 0;
  let afterBlock = afterBlockIn;
  for (;;) {
    const at = findDirectiveIn(text, from);
    if (at < 0) break;
    const directive = parseDirective(text, at + OPEN.length, true);
    // Read cleanly, or the bytes stay as the model wrote them: a card drawn from
    // half an answer is worse than the directive the client can still read
    if (directive.kind !== "ok") {
      from = at + OPEN.length;
      continue;
    }
    const gap = text.slice(emitted, at);
    const joined = afterBlock && isWhitespace(gap) && gap.length <= MAX_GAP;
    out.push(joined ? "\n\n" : gap);
    out.push(renderComment(directive.attrs));
    emitted = directive.end;
    from = directive.end;
    afterBlock = true;
  }
  out.push(text.slice(emitted));
  return { out: out.join(""), afterBlock };
}

/**
 * The same rewrite, for an answer that arrived whole
 *
 * The text is split into fenced blocks and plain stretches first, and the
 * directives are looked for in the plain stretches only: a directive the model
 * printed inside a fence is an example, and an example has to come out exactly
 * as it went in
 */
export function rewriteCodeComments(text: string): string {
  const gate = fenceGate();
  let out = "";
  let afterBlock = false;
  for (const segment of [...gate.push(text), ...gate.flush()]) {
    if (segment.code) {
      out += segment.text;
      // Between two comments something was written, so they are not adjacent
      afterBlock = false;
      continue;
    }
    const plain = rewritePlainText(segment.text, afterBlock);
    out += plain.out;
    afterBlock = plain.afterBlock;
  }
  return out;
}

/** One decided stretch of the answer: `code` is inside a fenced block, where nothing is rewritten */
interface Segment {
  text: string;
  code: boolean;
}

/** A fenced block that is open: its fence character, and the length a closing run has to reach */
interface Fence {
  char: string;
  len: number;
}

/**
 * Where the gate stands in the line it is reading
 *
 * `indent` — at most three spaces so far, so a fence can still open here
 * `opening` — the opening run, which a closing run has to match in length
 * `run` — a run of fence characters inside a block, which may close it
 * `after` — whitespace after that run, still a closer if the line ends here
 * `content` — a line that cannot be a fence marker
 */
type Phase = "indent" | "opening" | "run" | "after" | "content";

interface Segmenter {
  /** Decided stretches, in order; an undecided tail waits for the next chunk */
  push(chunk: string): Segment[];
  /** Whatever was still undecided, as plain text: the text ended, so it never became a fence */
  flush(): Segment[];
}

/**
 * The fenced-block reader both entry points go through
 *
 * A fence is line-shaped, so the only thing that ever has to be held back is a
 * tail that could still become an opening run — three characters at most. Text
 * inside a block leaves on the push that brought it: whether a line closes the
 * block is decided at its newline, and the bytes are the same either way.
 *
 * An unclosed fence runs to the end of the text, which is what Markdown says and
 * what a model that ran out of room wrote.
 *
 * That has a price, and it is paid on purpose:
 *
 *   - the rule is CommonMark's: three backticks (or three tildes) at the head of
 *     a line open a block, and from that byte on nothing is prose until a run of
 *     the same character, at least as long, closes it
 *   - so an answer that opens a fence and never closes it keeps every later
 *     `::code-comment{` verbatim — those directives reach the agent as the
 *     literal text, and no card is drawn for the rest of that answer
 *   - rewriting them instead would be worse: a block is the model *showing*
 *     text — the syntax, a diff, somebody else's file — so a rewrite inside one
 *     puts words in the model's mouth, while leaving it alone still hands the
 *     reader the bytes the model actually wrote
 *
 * Which side of that trade is right is a judgement, not something a test can
 * settle; what the tests do is pin it, so that changing it is a red line and not
 * a difference nobody looks at
 */
function fenceGate(): Segmenter {
  /** Undecided input: a tail that might still be an opening run */
  let pending = "";
  /** The open fenced block, or null outside one */
  let fence: Fence | null = null;
  /** Where the line at the cursor stands */
  let phase: Phase = "indent";
  /** The spaces at the line head, or the fence characters in the line's run */
  let count = 0;

  const scan = (final: boolean): Segment[] => {
    const segments: Segment[] = [];
    let current = "";
    let currentCode = false;
    const flushCurrent = () => {
      if (current) segments.push({ text: current, code: currentCode });
      current = "";
    };
    const emit = (text: string, code: boolean) => {
      if (!text) return;
      if (code !== currentCode) {
        flushCurrent();
        currentCode = code;
      }
      current += text;
    };

    let i = 0;
    scan: while (i < pending.length) {
      const c = pending[i];

      if (fence) {
        // A line that is already known not to be a closer leaves at once
        if (c !== "\n" && phase === "content") {
          const end = pending.indexOf("\n", i);
          emit(pending.slice(i, end < 0 ? pending.length : end), true);
          i = end < 0 ? pending.length : end;
          continue;
        }
        emit(c, true);
        i++;
        if (c === "\n") {
          // The line ended, so a run that filled it decides the block
          if ((phase === "run" || phase === "after") && count >= fence.len) fence = null;
          phase = "indent";
          count = 0;
        } else if (phase === "indent") {
          if (c === " ") {
            count++;
            if (count > 3) phase = "content";
          } else if (c === fence.char) {
            phase = "run";
            count = 1;
          } else {
            phase = "content";
          }
        } else if (phase === "opening") {
          // Still the opening run, unless the info string has started
          if (c === fence.char) {
            count++;
            fence.len = count;
          } else {
            phase = "content";
          }
        } else if (phase === "run") {
          if (c === fence.char) count++;
          else if (isSpaceChar(c)) phase = "after";
          else phase = "content";
        } else if (phase === "after" && !isSpaceChar(c)) {
          phase = "content";
        }
        continue;
      }

      // Outside a block: only a line head can start one, and only the first
      // three characters of that line can still be one
      if (c !== "\n" && phase === "content") {
        const end = pending.indexOf("\n", i);
        emit(pending.slice(i, end < 0 ? pending.length : end), false);
        i = end < 0 ? pending.length : end;
        continue;
      }
      if (c === "\n") {
        emit(c, false);
        i++;
        phase = "indent";
        count = 0;
        continue;
      }
      if (c === " ") {
        // A fourth space is an indented code block, which is not tracked: telling
        // one from a paragraph takes more than a line prefix, and a fence that
        // was not there would stop rewriting ordinary answers
        if (count >= 3) phase = "content";
        else count++;
        emit(c, false);
        i++;
        continue;
      }
      if (c === "`" || c === "~") {
        let end = i;
        while (end < pending.length && pending[end] === c) end++;
        const run = end - i;
        // Under three: inline code, unless the run is still growing in the next
        // chunk, which is the one thing worth waiting for
        if (run < 3) {
          if (end === pending.length && !final) break scan;
          emit(pending.slice(i, end), false);
          i = end;
          phase = "content";
          continue;
        }
        fence = { char: c, len: run };
        // The rest of this line is the info string, which is code as well
        emit(pending.slice(i, end), true);
        i = end;
        phase = "opening";
        count = run;
        continue;
      }
      // Anything else at the line head: this line is text, not a fence marker
      phase = "content";
      emit(c, false);
      i++;
    }
    flushCurrent();
    pending = pending.slice(i);
    return segments;
  };

  return {
    push: (chunk) => {
      pending += chunk;
      return scan(false);
    },
    flush: () => {
      const segments = scan(true);
      // A fence still open here is not closed and nothing is recovered for it:
      // the text ended inside a block, and every byte of it already left as code
      // (see the note on `fenceGate` for why that is the chosen side of the trade)
      //
      // What can still be pending is an opening run that never reached three
      // characters, and that was never a fence
      if (pending) {
        segments.push({ text: pending, code: false });
        pending = "";
      }
      return segments;
    },
  };
}

export interface StreamRewriter {
  /** What is settled: none of it can become part of a directive any more */
  push(chunk: string): string;
  /** What was still held — an unfinished directive, a possible opener, a gap — verbatim */
  flush(): string;
}

/**
 * The same rewrite, fed in pieces
 *
 * Only two things are ever held: the tail that matches the opening of
 * `::code-comment{`, and the inside of a directive. Everything else leaves on
 * the push that brought it, so a long answer still streams as it arrives
 */
export function codeCommentStream(): StreamRewriter {
  const gate = fenceGate();
  const plain = plainRewriter();
  const through = (segments: Segment[]) =>
    segments.map(({ text, code }) => plain.push(text, code)).join("");
  return {
    push: (chunk) => through(gate.push(chunk)),
    flush: () => through(gate.flush()) + plain.flush(),
  };
}

interface PlainRewriter {
  /** Settled text, rewritten; `code` goes out as it came */
  push(text: string, code: boolean): string;
  /** What was still held — an unfinished directive, a possible opener, a gap — verbatim */
  flush(): string;
}

/**
 * The directive rewrite alone, for text already known not to be inside a fence
 *
 * Separate from `codeCommentStream` so the fence reading stays one
 * implementation and this one stays testable against the whole-text path
 */
function plainRewriter(): PlainRewriter {
  /** Undecided input: ordinary text plus a possible opener, or one unfinished directive */
  let pending = "";
  /** Whether `pending` starts with an opener, so `parseDirective` reads from its end */
  let inDirective = false;
  /** The last thing emitted was a block, so a whitespace-only gap before the next one becomes a blank line */
  let afterBlock = false;

  const drain = (final: boolean): string => {
    let out = "";
    for (;;) {
      if (inDirective) {
        const directive = parseDirective(pending, OPEN.length, final);
        // Not decided yet: the rest of the directive may still arrive
        if (directive.kind === "open") return out;
        // Not something a card can be drawn from. The opener leaves as it came and
        // the scan resumes inside the rest, so a later directive still gets its card
        // and every byte the model wrote is preserved
        if (directive.kind === "bad") {
          out += pending.slice(0, OPEN.length);
          pending = pending.slice(OPEN.length);
          inDirective = false;
          afterBlock = false;
          if (pending.length === 0) return out;
          continue;
        }
        out += renderComment(directive.attrs);
        pending = pending.slice(directive.end);
        inDirective = false;
        afterBlock = true;
        if (pending.length === 0) return out;
        continue;
      }

      const at = findDirectiveIn(pending, 0);
      if (at >= 0) {
        const gap = pending.slice(0, at);
        out += afterBlock && isWhitespace(gap) && gap.length <= MAX_GAP ? "\n\n" : gap;
        pending = pending.slice(at);
        inDirective = true;
        continue;
      }

      // Hold the longest tail that could still become an opener: `::code-` waits,
      // `::code-x` does not
      const stop = pending.length - tailPrefix(pending);
      const plain = pending.slice(0, stop);      // Right after a block, whitespace may still be the gap before another one, so
      // it waits for the next character instead of being emitted as the author's own
      if (!final && (stop === 0 || (afterBlock && isWhitespace(plain)))) return out;
      // The text ended on something that could have become an opener and never
      // did. With nothing left to push there is nothing to wait for: `stop === 0`
      // on a final drain means the whole tail is that prefix, so it has to leave
      // here. Emitting `plain` and slicing by 0 leaves `pending` untouched and
      // spins this loop forever — blocking the event loop the stream runs on, so
      // the client waits for an answer that never ends
      if (final && stop === 0) {
        out += pending;
        pending = "";
        return out;
      }
      out += plain;
      if (!isWhitespace(plain)) afterBlock = false;
      pending = pending.slice(stop);
      if (pending.length === 0) return out;
    }
  };

  return {
    push: (text, code) => {
      if (code) {
        // A fence the model wrote is the model's own bytes, and a directive cannot
        // reach across it: whatever was held was not a directive after all
        const held = pending;
        pending = "";
        inDirective = false;
        // Something was written between the last comment and the next one, so
        // they are not adjacent and keep their own spacing
        afterBlock = false;
        return held + text;
      }
      pending += text;
      return drain(false);
    },
    flush: () => drain(true),
  };
}

/** The longest suffix of `text` that is a proper prefix of the opener */
function tailPrefix(text: string): number {
  for (let k = Math.min(text.length, OPEN.length - 1); k > 0; k--) {
    if (text.endsWith(OPEN.slice(0, k))) return k;
  }
  return 0;
}
