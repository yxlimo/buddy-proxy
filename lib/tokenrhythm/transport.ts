// lib/tokenrhythm/transport.ts — the inference side.
//
// TokenRhythm speaks the OpenAI dialect, so nothing is converted on the way
// there. The one thing that has to be adjusted is the thinking: in DeepSeek's
// thinking mode a request that ends with a tool result must carry the
// assistant's `reasoning_content` back, even when it is empty — otherwise the
// upstream answers 400. A client that switched models mid-conversation leaves
// that field out, so the gateway puts it back.

import { AuthError } from "../credential.ts";
import { TOKENRHYTHM_INFER_BASE, tokenRhythmTenant, type TokenRhythmTenant } from "./accounts.ts";

/**
 * Put the thinking back into the assistant messages.
 *
 * Only the messages that carry tool calls need it, and only when the field is
 * missing: `reasoning_content: null` is a type error upstream, so an empty
 * string is what goes in.
 */
export function restoreReasoningContent(body: Record<string, any>): void {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    if (!Array.isArray(message?.tool_calls) || message.tool_calls.length === 0) continue;
    if (message.reasoning_content === undefined) message.reasoning_content = "";
  }
}

/** The key the inference uses, and the tenant it belongs to. */
export function inferenceTenant(index: number): { tenant: TokenRhythmTenant; key: string } {
  const tenant = tokenRhythmTenant(index);
  if (!tenant) {
    throw new AuthError(`no tenant ${index} configured`, `没有配置第 ${index} 个 TokenRhythm 租户。`, 500);
  }
  if (!tenant.apiKey) {
    throw new AuthError(
      `tenant ${index} has no inference key`,
      `第 ${index} 个 TokenRhythm 租户没有配置 API key。设置 TOKENRHYTHM_${index}_API_KEY 后重启服务。`,
      500,
    );
  }
  return { tenant, key: tenant.apiKey };
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

/** Whether the platform's own answer says it is busy. */
function isBusy(status: number, code: unknown): boolean {
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
 * The account has no money left.
 *
 * Unlike "the service is busy", this does not get better by waiting: the
 * tenant cannot serve anything until it is recharged. The caller switches to
 * another tenant.
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
  index: number,
  body: Record<string, any>,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; key: string }> {
  const { tenant, key } = inferenceTenant(index);
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
    throw new AuthError(
      "tokenrhythm rejected the key",
      `TokenRhythm 拒绝了第 ${index} 个租户的 key（HTTP 401）。`,
      502,
    );
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
      parsed?.message ?? "账户余额不足，请充值后重试",
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
    if (isBusy(response.status, detail.code)) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      throw new TokenRhythmBusyError(
        parsed?.message ?? "服务繁忙，请稍后重试",
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2,
        detail.traceId,
      );
    }
    throw new AuthError(
      `upstream HTTP ${response.status}`,
      `TokenRhythm 上游返回 ${response.status}：${text.slice(0, 300)}`,
      502,
    );
  }
  return { response, key: tenant.apiKey ?? key };
}
