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

/**
 * The index of the `}` that closes the attribute list, or -1 when the text ends
 * first
 *
 * Quotes first, brace second: `body="… has no key} really"` closes at the brace
 * outside the quotes, not at the one inside
 */
function closeIndex(text: string, from: number): number {
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "}") return i;
  }
  return -1;
}

/**
 * The attributes of one directive, name → value
 *
 * Lenient on purpose: the model drops quotes, forgets a space before the next
 * attribute, or writes `start=10` bare, and none of that is a reason to leave
 * the directive in the answer. A backslash makes the next character ordinary,
 * quoted or not, so a path or a quote inside a value survives
 */
function parseAttributes(src: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 0;
  while (i < src.length) {
    while (i < src.length && isSpaceChar(src[i])) i++;
    if (i >= src.length) break;
    let keyEnd = i;
    while (keyEnd < src.length && /[A-Za-z0-9_-]/.test(src[keyEnd])) keyEnd++;
    if (keyEnd === i) {
      i++;
      continue;
    }
    const key = src.slice(i, keyEnd).toLowerCase();
    i = keyEnd;
    while (i < src.length && isSpaceChar(src[i])) i++;
    if (src[i] !== "=") {
      attrs.set(key, "");
      continue;
    }
    i++;
    while (i < src.length && isSpaceChar(src[i])) i++;
    let value = "";
    const end = src[i];
    if (end === '"' || end === "'") {
      i++;
      while (i < src.length && src[i] !== end) {
        if (src[i] === "\\" && i + 1 < src.length) {
          value += src[i + 1];
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      i++;
    } else {
      while (i < src.length && !isSpaceChar(src[i])) {
        if (src[i] === "\\" && i + 1 < src.length) {
          value += src[i + 1];
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
    }
    attrs.set(key, value);
  }
  return attrs;
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

const lineNumber = (value: string | undefined): number | undefined => {
  const text = (value ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : undefined;
};

/** `foo.ts:10-11` — the file by its last segment, the range only when it says one */
function location(attrs: Map<string, string>): string {
  const file = (attrs.get("file") ?? "").trim();
  if (!file) return "";
  const name = file.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? file;
  const lines = [lineNumber(attrs.get("start")), lineNumber(attrs.get("end"))].filter(
    (line): line is number => line !== undefined,
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
    const close = closeIndex(text, at + OPEN.length);
    // Never closed: what the model wrote stays as it wrote it
    if (close < 0) break;
    const attrs = text.slice(at + OPEN.length, close);
    // The same ceiling the stream uses, or the two would disagree on a stray opener
    if (OPEN.length + attrs.length + 1 > MAX_DIRECTIVE) {
      from = close + 1;
      continue;
    }
    const gap = text.slice(emitted, at);
    const joined = afterBlock && isWhitespace(gap) && gap.length <= MAX_GAP;
    out.push(joined ? "\n\n" : gap);
    out.push(renderComment(parseAttributes(attrs)));
    emitted = close + 1;
    from = close + 1;
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
  /** How far into the directive `pending` has been scanned; quote state makes rescanning wrong */
  let pos = 0;
  let inDirective = false;
  let quote = "";
  let escaped = false;
  /** The last thing emitted was a block, so a whitespace-only gap before the next one becomes a blank line */
  let afterBlock = false;

  const drain = (final: boolean): string => {
    let out = "";
    for (;;) {
      if (inDirective) {
        let i = pos;
        for (; i < pending.length && i < MAX_DIRECTIVE; i++) {
          const c = pending[i];
          if (escaped) {
            escaped = false;
            continue;
          }
          if (c === "\\") {
            escaped = true;
            continue;
          }
          if (quote) {
            if (c === quote) quote = "";
            continue;
          }
          if (c === '"' || c === "'") {
            quote = c;
            continue;
          }
          if (c === "}") break;
        }
        if (i < pending.length && i < MAX_DIRECTIVE && pending[i] === "}") {
          out += renderComment(parseAttributes(pending.slice(OPEN.length, i)));
          pending = pending.slice(i + 1);
          pos = 0;
          inDirective = false;
          quote = "";
          escaped = false;
          afterBlock = true;
          continue;
        }
        if (i >= MAX_DIRECTIVE) {
          // Too long to be one of ZCode's comments: give up on this one and keep
          // reading, so an opener that never closes costs 8192 characters and no more
          out += pending.slice(0, i);
          pending = pending.slice(i);
          pos = 0;
          inDirective = false;
          quote = "";
          escaped = false;
          afterBlock = false;
          continue;
        }
        pos = i;
        if (final) {
          out += pending;
          pending = "";
          pos = 0;
        }
        return out;
      }

      const at = findDirectiveIn(pending, 0);
      if (at >= 0) {
        const gap = pending.slice(0, at);
        out += afterBlock && isWhitespace(gap) && gap.length <= MAX_GAP ? "\n\n" : gap;
        pending = pending.slice(at);
        pos = OPEN.length;
        inDirective = true;
        quote = "";
        escaped = false;
        continue;
      }

      // Hold the longest tail that could still become an opener: `::code-` waits,
      // `::code-x` does not
      const stop = pending.length - tailPrefix(pending);
      const plain = pending.slice(0, stop);
      // Right after a block, whitespace may still be the gap before another one, so
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
        pos = 0;
        return out;
      }
      out += plain;
      if (!isWhitespace(plain)) afterBlock = false;
      pending = pending.slice(stop);
      pos = 0;
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
        pos = 0;
        inDirective = false;
        quote = "";
        escaped = false;
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
