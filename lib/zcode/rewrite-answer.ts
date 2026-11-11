// lib/zcode/rewrite-answer.ts — the `::code-comment` rewrite, on the wire.
//
// lib/zcode/rewrite.ts turns one directive into Markdown; this is where that
// meets a ZCode answer. The answer arrives two ways and both have to be
// covered, or an agent sees the directive spelled out in whichever shape it
// happened not to ask for:
//
//   whole (a buffered JSON body)  → every text block rewritten in one go
//   in pieces (an Anthropic SSE stream) → the text deltas rewritten as they pass
//
// Only text is touched. `thinking`, `tool_use.input` and the JSON of a tool's
// arguments are the upstream's own bytes: a comment formatter that reached into
// them would corrupt a tool call, and nothing downstream would notice until the
// tool failed. So the SSE path re-serialises a frame only when it changes one,
// and every other frame goes out as the bytes it came in as (`raw`).
//
// Order matters and is the reason the residual delta is written where it is: the
// incremental rewriter holds back a tail that could still become a directive.
// That tail is the end of the text block it came from, so it has to leave
// *before* that block's `content_block_stop` — a text delta after the stop
// arrives at a client that has already closed the block.

import { codeCommentStream, rewriteCodeComments } from "./rewrite.ts";

/** The rewrite, for an answer that arrived whole. `content[]`'s text blocks only */
export function rewriteAnswerBody(json: any): any {
  const content = json?.content;
  if (!Array.isArray(content)) return json;
  let changed = false;
  const blocks = content.map((block: any) => {
    // A block that is not text — thinking, tool_use, redacted_thinking — is the
    // upstream's own and keeps its bytes
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const text = rewriteCodeComments(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  // Untouched answers are handed back as they came, so nothing that reads the
  // object afterwards can tell this ran at all
  return changed ? { ...json, content: blocks } : json;
}

/** One SSE frame: its own lines verbatim, plus the two fields worth reading */
interface Frame {
  /** The frame's lines as they arrived, without the blank line that ends it */
  raw: string;
  /** The `event:` name, when the frame has one */
  event: string | undefined;
  /** The `data:` payload; several data lines are joined with a newline, as SSE says */
  data: string;
}

function parseFrame(raw: string): Frame {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    const bare = line.replace(/\r$/, "");
    if (bare.startsWith("event:")) event = bare.slice(6).trim();
    else if (bare.startsWith("data:")) data.push(bare.slice(5).replace(/^ /, ""));
  }
  return { raw, event, data: data.join("\n") };
}

/**
 * The frame's payload as an object, or null when it is not JSON we can read
 *
 * Strict parse on purpose: a frame we cannot read is forwarded as it came. The
 * rewrite is not worth corrupting an answer over
 */
function jsonOf(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The rewrite, for an answer that arrives as a stream of Anthropic SSE bytes
 *
 * A pass-through except for `content_block_delta` frames carrying a
 * `text_delta`. Bytes are only held until the frame they belong to is complete,
 * so the first frame is delayed by the length of one frame and no more —
 * `lib/router/deliver.ts` reads the first frame before it commits the response
 * headers, and a wrapper that buffered for its own reasons would cost the
 * caller the chance to switch targets.
 */
export function rewriteAnswerStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const rewriter = codeCommentStream();
  /** Whole chunks ready for the client; `pull` hands out one per read */
  const ready: Uint8Array[] = [];
  /** Decoded bytes that are not a whole line yet */
  let buffer = "";
  /** The frame being read, verbatim with its own line endings */
  let frame = "";
  let ended = false;
  /** The client cancelled: the upstream is being stopped and nobody is reading */
  let gone = false;
  /** The block whose text deltas are being rewritten; -1 before the first one */
  let textIndex = -1;

  const emit = (text: string) => {
    if (text) ready.push(encoder.encode(text));
  };

  const deltaFrame = (index: number, text: string) =>
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    })}\n\n`;

  /** What the rewriter still holds belongs to the block that is closing */
  const flushHeld = () => {
    const held = rewriter.flush();
    // An index of -1 means nothing was ever pushed, so nothing can be held
    if (held && textIndex >= 0) emit(deltaFrame(textIndex, held));
    textIndex = -1;
  };

  /** One complete frame, and the blank line that ended it */
  const handleFrame = (terminator: string) => {
    const raw = frame;
    frame = "";
    const parsed = parseFrame(raw);
    const json = jsonOf(parsed.data);
    if (json?.type === "content_block_delta" && json?.delta?.type === "text_delta") {
      if (typeof json.index === "number") textIndex = json.index;
      const text = rewriter.push(String(json.delta.text ?? ""));
      // Held back whole: an empty delta is a frame that says nothing
      if (text && textIndex >= 0) {
        const rewritten = { ...json, delta: { ...json.delta, text } };
        emit(`event: ${parsed.event ?? "content_block_delta"}\ndata: ${JSON.stringify(rewritten)}\n\n`);
      }
      return;
    }
    // The block is over: its held tail leaves first, then the stop it belongs to.
    // message_delta / message_stop are here for a stream that never sent a stop
    if (json?.type === "content_block_stop" || json?.type === "message_delta" || json?.type === "message_stop") {
      flushHeld();
    }
    emit(raw + terminator);
  };

  const readLines = () => {
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl + 1);
      buffer = buffer.slice(nl + 1);
      if (line === "\n" || line === "\r\n") {
        handleFrame(line);
        continue;
      }
      frame += line;
    }
  };

  const finish = () => {
    buffer += decoder.decode();
    readLines();
    // A frame the upstream cut in half goes out as it came: a truncated answer
    // is the upstream's business, not something to reformat
    emit(frame);
    frame = "";
    emit(buffer);
    buffer = "";
    flushHeld();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!ready.length) {
          // The client left while this pull was waiting on the upstream. Ending the
          // stream here would touch a controller that `cancel` has already closed
          if (gone) return;
          if (ended) {
            controller.close();
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
            finish();
            continue;
          }
          buffer += decoder.decode(value, { stream: true });
          readLines();
        }
        controller.enqueue(ready.shift()!);
      } catch (error) {
        // The client already left: `cancel` stopped the upstream and closed this
        // controller, so there is nothing left to stop and nobody to tell
        if (gone) return;
        // The read came back, so the upstream is alive — a throw here is this
        // file's own work (decoding, the rewriter, a re-serialised frame). Left
        // alone, the upstream keeps writing an answer nobody will ever read and
        // keeps counting tokens for it, so the reader is cancelled first: that is
        // the only path from here back to the socket. Only then is the client told
        gone = true;
        ready.length = 0;
        // A cancel that fails has nothing left to report: either the upstream is
        // already broken (its rejection is the error the client is about to get
        // anyway) or it is refusing to be stopped. Left unhandled, that rejection
        // takes the process down over a request that is already being answered
        // with an error
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) {
      // The client went away: the upstream has to stop too, it is still counting
      // tokens for an answer nobody is reading.
      //
      // Everyone above holds *this* stream, not the upstream's — `onClientGone`
      // and `onClientGoneTee` in lib/router/deliver.ts cancel what they were
      // handed — so this is the only path from a client that left to the bytes on
      // the socket. Without it the connection stays open until the upstream
      // finishes an answer nobody will read.
      gone = true;
      ready.length = 0;
      buffer = "";
      frame = "";
      return reader.cancel(reason);
    },
  });
}
