// test/legacy-wire.ts — the CLI protocol's wire format, both directions.
//
// The router signs and encodes a request; the upstream answers in its own frame
// format (`data:{"headers":…,"body":"<json>"}`). A fake upstream has to do the
// inverse of that encoding to know which model was asked for, and produce the
// frame shape to answer at all. Keeping both here means each fake says what it
// answers instead of how the wire looks.
//
// Nothing here talks to a network: it is the bytes, and nothing else.

/** Qoder's alphabet, in the order lib/qoder/legacy.ts maps onto it. */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const FROM_CUSTOM = new Map<string, string>();
for (let i = 0; i < STD_ALPHABET.length; i++) FROM_CUSTOM.set(CUSTOM_ALPHABET[i]!, STD_ALPHABET[i]!);
FROM_CUSTOM.set("$", "=");

/**
 * The request body the router sent, as the object it started from.
 *
 * The encoding is standard base64 rearranged in thirds and then mapped onto
 * Qoder's alphabet (see lib/qoder/legacy.ts), so decoding undoes both — in the
 * other order.
 */
export function decodeLegacyBody(raw: string): any {
  const rearranged = [...raw].map((ch) => FROM_CUSTOM.get(ch) ?? ch).join("");
  const split = Math.floor(rearranged.length / 3);
  const first = rearranged.slice(rearranged.length - split);
  const middle = rearranged.slice(split, rearranged.length - split);
  const last = rearranged.slice(0, split);
  return JSON.parse(Buffer.from(first + middle + last, "base64").toString("utf8"));
}

/** The key the router asked for, in either place the body carries it. */
export function legacyModelKey(body: any): string {
  return String(body?.model_config?.key ?? body?.chat_context?.extra?.modelConfig?.key ?? "");
}

/** One frame, the way the upstream writes it: a JSON object in a JSON string. */
export function legacyFrame(payload: unknown, statusCode?: number): string {
  return `data:${JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    // 壳上的状态是上游对这条请求的答复状态：有它，读帧的那一层就按「壳说
    // 出了问题」走（见 lib/qoder/legacy.ts 的 readLegacyFrames）。
    ...(statusCode !== undefined ? { statusCodeValue: statusCode } : {}),
    body: JSON.stringify(payload),
  })}\n`;
}

/** One answer chunk. */
export function legacyChunk(content: string, extra: Record<string, unknown> = {}): string {
  return legacyFrame({ choices: [{ index: 0, delta: { role: "assistant", content }, ...extra }] });
}

/** The last frame of a normal answer: the finish reason and the usage. */
export function legacyEnd(usage: Record<string, number> = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }): string {
  return legacyFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
}

/**
 * 一个错误帧：上游在 200 的流里说「这一跳不行」。
 *
 * 这是生产上的那个形状（正文里一个 `error`），它不带状态 —— 读帧的那一层把
 * 这种帧当成「上游说了什么」，而不是「上游的 HTTP 是多少」。所以用它只能验
 * 排队/拒绝这类「上游自己解释自己」的答复。
 */
export function legacyErrorFrame(message: string, code = "403"): string {
  return legacyFrame({ error: { code, message } });
}

/**
 * 壳上说出了问题的帧：状态在壳上（statusCodeValue），原因在正文顶层。
 *
 * 这是另一条真形状：读帧的那一层把壳上的状态当成上游对这个请求的答复状态，
 * 路由就靠它分清「请求本身的问题」与「这个账号接不了」。
 */
export function legacyStatusErrorFrame(status: number, message: string, code = String(status)): string {
  return legacyFrame({ code, message }, status);
}

/** The queue answer's message, nested the way the upstream nests it. */
export function legacyQueueMessage(retryAfterSeconds?: number): string {
  const inner = {
    errorCode: 0,
    isQueued: true,
    queueCount: 1,
    subCode: "RESOURCE_LIMIT",
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds, waitTime: retryAfterSeconds } : {}),
  };
  return JSON.stringify({ code: "10605", message: JSON.stringify(inner), subCode: "RESOURCE_LIMIT" });
}
