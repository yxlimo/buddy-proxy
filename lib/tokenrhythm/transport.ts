// lib/tokenrhythm/transport.ts — the inference side.
//
// TokenRhythm speaks the OpenAI dialect, so nothing is converted on the way
// there. The one thing that has to be adjusted is the thinking: in DeepSeek's
// thinking mode a request that ends with a tool result must carry the
// assistant's `reasoning_content` back, even when it is empty — otherwise the
// upstream answers 400. A client that switched models mid-conversation leaves
// that field out, so the gateway puts it back.

import type { Json } from "../json.ts";
import { AuthError } from "../credential.ts";
import { withBusinessCode, withUpstreamAnswer, withUpstreamBody } from "../upstream-status.ts";
import { scrubForClient } from "../log-scrub.ts";
import { tokenRhythmCredentialOf, type TokenRhythmCredential } from "./accounts.ts";
import { TOKENRHYTHM_INFER_BASE } from "./config.ts";

/**
 * Put the thinking back into the assistant messages.
 *
 * Only the messages that carry tool calls need it, and only when the field is
 * missing: `reasoning_content: null` is a type error upstream, so an empty
 * string is what goes in.
 */
export function restoreReasoningContent(body: Json): void {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    if (!Array.isArray(message?.tool_calls) || message.tool_calls.length === 0) continue;
    if (message.reasoning_content === undefined) message.reasoning_content = "";
  }
}

/** The key the inference uses, and the account it belongs to. */
export function inferenceAccount(accountId: string): { credential: TokenRhythmCredential; key: string } {
  const credential = tokenRhythmCredentialOf(accountId);
  if (!credential) {
    throw new AuthError(`no tokenrhythm account ${accountId}`, `没有这个 TokenRhythm 账号：${accountId}。`, 500);
  }
  if (!credential.apiKey) {
    throw new AuthError(
      `tokenrhythm account ${accountId} has no inference key`,
      `TokenRhythm 账号 ${accountId} 没有推理用的 key。在面板上给它配一把。`,
      500,
    );
  }
  return { credential, key: credential.apiKey };
}

/**
 * Send the request upstream.
 *
 * The answer comes back as the upstream's own bytes: it is an OpenAI stream or
 * an OpenAI object, and the gateway hands it on.
 */
/**
 * The upstream is busy.
 *
 * The relay answers 503 with `SERVICE_BUSY` when its backends are all taken.
 * That is not a failure of the request: the same request may go through on
 * another account, or a moment later.
 */
export class TokenRhythmBusyError extends Error {
  status: number;
  retryAfterSec: number;
  traceId: string;
  constructor(message: string, retryAfterSec = 2, traceId = "") {
    super(message);
    this.status = 503;
    this.retryAfterSec = retryAfterSec;
    this.traceId = traceId;
  }
}

/**
 * Whether the relay's own answer says it is busy.
 *
 * 名字里的 `Relay` 不能省：这里判的是中转站（TokenRhythm）那一家的答复形状，
 * 不是「这次请求忙不忙」的通用判断。叫 `isBusy` 会让人以为它是别处删掉的那个
 * 同名函数又回来了。
 */
function isRelayBusy(status: number, code: unknown): boolean {
  if (status === 429) return true;
  if (status !== 503) return false;
  const text = String(code ?? "").toUpperCase();
  return text.includes("BUSY") || text.includes("SERVICE_UNAVAILABLE") || text === "";
}

/** The platform's error code and trace id, if the answer carries them. */
function busyDetail(body: any): { code: string; traceId: string } {
  return {
    code: String(body?.code ?? ""),
    traceId: String(body?.traceId ?? body?.trace_id ?? ""),
  };
}

/**
 * 中转站那句原话，抹过再交出去；它没说就返回 null（让网关自己那句顶上）。
 *
 * 这句会进客户端看到的东西（TokenRhythmBusyError / TokenRhythmNoBalanceError 的
 * message，续而进 policy.ts 的 hint）。中转站的正文里可能写着 key 片段、邮箱，
 * 所以抹的规矩与日志那边是同一套（见 lib/log-scrub.ts 的 scrubForClient）。
 */
function upstreamSaid(message: unknown): string | null {
  if (typeof message !== "string") return null;
  return scrubForClient(message, 300) || null;
}

/**
 * The account has no money left.
 *
 * Unlike "the service is busy", this does not get better by waiting: the
 * account cannot serve anything until it is recharged. The caller switches to
 * another account.
 */
export class TokenRhythmNoBalanceError extends Error {
  status = 402;
  traceId: string;

  constructor(message: string, traceId: string) {
    super(message);
    this.name = "TokenRhythmNoBalanceError";
    this.traceId = traceId;
  }
}

export async function tokenRhythmChat(
  accountId: string,
  body: Json,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; key: string }> {
  const { credential, key } = inferenceAccount(accountId);
  const payload = { ...body, model: body.model };
  restoreReasoningContent(payload);
  const response = await fetch(`${TOKENRHYTHM_INFER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: body.stream ? "text/event-stream" : "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok && response.status === 401) {
    // 正文要读：401 的正文往往就是 `invalid api key` 那一句，排查时最需要它。
    // 读不到就挂空串 —— 宁可客户端拿到一句空话，也别把「上游为什么拒」丢了。
    const text = await response.text().catch(() => "");
    const error = new AuthError(
      "tokenrhythm rejected the key",
      `TokenRhythm 拒绝了账号 ${accountId} 的 key（HTTP 401）。`,
      502,
    );
    // The client sees the gateway's status; the upstream's own status (and its
    // own body, whenever the retries run out) says whether the next account
    // would do better.
    withUpstreamAnswer(error, 401, text);
    throw error;
  }
  if (!response.ok && response.status === 402) {
    const text = await response.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    const detail = busyDetail(parsed);
    throw new TokenRhythmNoBalanceError(
      upstreamSaid(parsed?.message) ?? "账户余额不足，请充值后重试",
      detail.traceId,
    );
  }
  if (!response.ok && (response.status === 429 || response.status === 503)) {
    const text = await response.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    const detail = busyDetail(parsed);
    if (isRelayBusy(response.status, detail.code)) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      // 正文要带，状态不带。
      //
      // 中转站的 429/503 说的是「服务繁忙，过会儿再来」，不是「你这个账号这一
      // 分钟被限流了」。把它的 429 挂到错误上，分类就从 server 变成 rate-limit：
      // 忙时会给账号记一分钟冷却，策略还会在请求里替它等限流窗口 —— 而「等」
      // 已经花了两单才从降级路径上拿掉（见 lib/qoder/queue.ts）。所以状态留这
      // 个类自己的 503（见上面那个类的说明），只把上游原话挂上去：重试用尽时
      // 客户端读的是上游那句，而不是网关编的一句「上游返回 503。」。
      throw withUpstreamBody(
        new TokenRhythmBusyError(
          upstreamSaid(parsed?.message) ?? "服务繁忙，请稍后重试",
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2,
          detail.traceId,
        ),
        text,
      );
    }
    const error = new AuthError(
      `upstream HTTP ${response.status}`,
      // 客户端看到的是这一句：上游正文里可能带着 key 片段与邮箱，打出去之前抹一遍。
      `TokenRhythm 上游返回 ${response.status}：${scrubForClient(text, 300)}`,
      502,
    );
    // The client sees the gateway's status; the upstream's own status says
    // whether the next account would do better (a 400 is the request's fault),
    // and its own body goes with it: that answer is what the client reads when
    // the retries run out.
    withUpstreamAnswer(error, response.status, text);
    const code = busyDetail(parsed).code;
    if (code) withBusinessCode(error, code);
    throw error;
  }
  return { response, key: credential.apiKey ?? key };
}
