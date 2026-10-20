// lib/qoder-legacy.ts — Qoder's legacy (COSY) protocol.
//
// The new protocol (api2-v2.qoder.sh) is an OpenAI endpoint and easy to talk to,
// but it only accepts eight model keys. The legacy protocol (api3.qoder.sh) is
// the one the CLI itself uses, and it accepts the version-pinned keys that the
// free flash models live under — `dfmodel` for DeepSeek-Flash, `qfmodel` for
// Qwen3.8-Flash. It is also the only path the CN region has, since the new
// protocol is not deployed there.
//
// What it costs is a signed request:
//
//   temp_key  = 16 bytes
//   cosy_key  = base64(RSA-PKCS1v15(server public key, temp_key))
//   info      = base64(AES-128-CBC-PKCS7(identity json, temp_key))
//   payload   = base64(sorted json of {cosyVersion, ideVersion, info, requestId, version})
//   signature = md5(payloadB64 \n cosy_key \n cosy_date \n body \n path-without-/algo)
//   Authorization: Bearer COSY.<payloadB64>.<signature>
//
// The body itself is Qoder's own base64: the standard alphabet is rearranged in
// thirds and then mapped onto a custom alphabet.
//
// The identity is the device-flow token. The `security_oauth_token` field is
// where Qoder's own CLI puts its `dt-` token, so no separate personal token is
// needed — which is the one thing the published Python implementations cannot do.
//
// The response is a private SSE format: each frame is
// `data:{"headers":…,"body":"<json string>"}`, where the inner JSON is a regular
// OpenAI chat completion chunk. Errors arrive as their own frames.

import crypto from "node:crypto";
import { AuthError } from "./credential.ts";
import { ensureCredential, loadSession, type QoderRegion } from "./qoder-auth.ts";
import { readEnvString } from "./env.ts";

/** Qoder's server public key. Fixed; the protocol has never rotated it. */
const SERVER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const COSY_VERSION = "0.1.43";

const LEGACY_ENDPOINTS: Record<QoderRegion, string> = {
  cn: "https://gateway.qoder.com.cn",
  global: "https://api3.qoder.sh",
};

/* ------------------------------------------------------------------ *
 * Qoder's base64
 * ------------------------------------------------------------------ */

const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const TO_CUSTOM = new Map<string, string>();
for (let i = 0; i < STD_ALPHABET.length; i++) TO_CUSTOM.set(STD_ALPHABET[i]!, CUSTOM_ALPHABET[i]!);
TO_CUSTOM.set("=", "$");

/** Standard base64, rearranged in thirds, then mapped onto Qoder's alphabet. */
export function qoderBase64Encode(bytes: Buffer): string {
  const standard = bytes.toString("base64");
  const split = Math.floor(standard.length / 3);
  const rearranged = standard.slice(-split) + standard.slice(split, -split) + standard.slice(0, split);
  let out = "";
  for (const ch of rearranged) out += TO_CUSTOM.get(ch) ?? ch;
  return out;
}

/* ------------------------------------------------------------------ *
 * Session and signature
 * ------------------------------------------------------------------ */

export interface LegacyIdentity {
  name: string;
  aid: string;
  uid: string;
  yx_uid: string;
  organization_id: string;
  organization_name: string;
  user_type: string;
  security_oauth_token: string;
  refresh_token: string;
}

export interface LegacySession {
  tempKey: Buffer;
  cosyKey: string;
  info: string;
  identity: LegacyIdentity;
  machineId: string;
  machineToken: string;
  machineType: string;
}

/** The identity the CLI itself stores in `~/.qoder/.auth/user`. */
export async function buildSession(region: QoderRegion = "global"): Promise<LegacySession> {
  const cred = await ensureCredential(false, region);
  const stored = loadSession(region);
  const uid = stored?.userId ?? "";
  const identity: LegacyIdentity = {
    name: readEnvString("QODER_ACCOUNT_NAME", ""),
    aid: uid,
    uid,
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: readEnvString("QODER_USER_TYPE", "personal_professional_trial"),
    security_oauth_token: cred.accessToken,
    refresh_token: stored?.refreshToken ?? "",
  };

  const tempKey = Buffer.from(crypto.randomUUID().replace(/-/g, "").slice(0, 16), "ascii");
  const cosyKey = crypto
    .publicEncrypt({ key: SERVER_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, tempKey)
    .toString("base64");
  const info = aesEncrypt(Buffer.from(JSON.stringify(identity), "utf8"), tempKey).toString("base64");

  const machine = stored
    ? { id: stored.machineId, token: stored.machineToken, type: stored.machineType }
    : { id: crypto.randomUUID(), token: crypto.randomUUID().replace(/-/g, ""), type: crypto.randomUUID().replace(/-/g, "").slice(0, 18) };

  return { tempKey, cosyKey, info, identity, machineId: machine.id, machineToken: machine.token, machineType: machine.type };
}

/** AES-128-CBC with PKCS#7 padding; the key doubles as the IV, as Qoder does. */
function aesEncrypt(plain: Buffer, key: Buffer): Buffer {
  const pad = 16 - (plain.length % 16);
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function buildPayloadB64(info: string): string {
  const payload = {
    cosyVersion: COSY_VERSION,
    ideVersion: "",
    info,
    requestId: crypto.randomUUID(),
    version: "v1",
  };
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(payload).sort()) sorted[key] = payload[key as keyof typeof payload] as string;
  return Buffer.from(JSON.stringify(sorted), "utf8").toString("base64");
}

export function signRequest(payloadB64: string, cosyKey: string, date: string, body: string, path: string): string {
  return crypto.createHash("md5").update(`${payloadB64}\n${cosyKey}\n${date}\n${body}\n${path}`).digest("hex");
}

/** The headers a legacy request needs. */
export function legacyHeaders(session: LegacySession, fullUrl: string, body: string): Record<string, string> {
  const path = new URL(fullUrl).pathname;
  const pathForSignature = path.startsWith("/algo") ? path.slice("/algo".length) : path;
  const payloadB64 = buildPayloadB64(session.info);
  const date = String(Math.floor(Date.now() / 1000));
  const signature = signRequest(payloadB64, session.cosyKey, date, body, pathForSignature);
  return {
    "cosy-data-policy": "AGREE",
    "content-type": "application/json",
    "cosy-machinetype": session.machineType,
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": session.identity.uid,
    "cosy-key": session.cosyKey,
    accept: "text/event-stream",
    "cosy-clientip": "169.254.198.161",
    authorization: `Bearer COSY.${payloadB64}.${signature}`,
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-machineid": session.machineId,
    "cosy-machinetoken": session.machineToken,
    "login-version": "v2",
    "user-agent": "Go-http-client/2.0",
    "cache-control": "no-cache",
  };
}

/* ------------------------------------------------------------------ *
 * Request body
 * ------------------------------------------------------------------ */

export interface LegacyRequestBody {
  /** OpenAI-shaped messages. */
  messages: Json[];
  tools?: Json[];
  /** The CLI's model key, e.g. `dfmodel`. */
  modelKey: string;
  displayName: string;
  maxTokens?: number;
  reasoning?: boolean;
  contextWindow?: number;
}

type Json = Record<string, any>;

const BLANK_RESPONSE_META = {
  is_input_modification: false,
  is_rewrite_title: false,
  user_input: "",
  response_rewrite: false,
  tool_call: null,
  tool_calls: [],
  finish_reason: null,
  function: "",
  action: "",
  client_error: null,
  is_web_call: false,
  web_call_info: [],
};

/** Qoder's own request shape for the legacy protocol. */
export function buildLegacyBody(req: LegacyRequestBody): Json {
  const text = String(req.messages?.[req.messages.length - 1]?.content ?? "");
  const system = req.messages?.find((m) => m.role === "system");
  const userMessages = req.messages.filter((m) => m.role !== "system");

  // The tool round trip has to survive: the upstream reads the assistant's
  // tool calls and the tool's answer out of `response_meta`, and without them
  // the model cannot tell that it already made the call — it calls the tool
  // again, and again. The upstream's own frames spell a tool call the OpenAI
  // way (`{id, type, function:{name, arguments}}`), so the request side uses
  // the same shape.
  const callsById = new Map<string, Json>();
  for (const m of userMessages) {
    for (const call of (m as any).tool_calls ?? []) {
      if (call?.id) callsById.set(call.id, call);
    }
  }

  // The legacy protocol only carries text in a message body.
  const textOf = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part: any) => (typeof part === "string" ? part : (part?.text ?? part?.content ?? "")))
        .filter(Boolean)
        .join("\n");
    }
    return content == null ? "" : JSON.stringify(content);
  };

  return {
    request_id: crypto.randomUUID(),
    request_set_id: crypto.randomUUID(),
    chat_record_id: crypto.randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      chatPrompt: "",
      extra: {
        context: [],
        modelConfig: { is_reasoning: req.reasoning ?? false, key: req.modelKey },
        originalContent: { type: "text", text },
      },
      features: [],
      imageUrls: null,
      text: { type: "text", text },
    },
    image_urls: null,
    is_reply: true,
    is_retry: false,
    session_id: crypto.randomUUID(),
    code_language: "",
    source: 1,
    version: "3",
    chat_prompt: "",
    parameters: { max_tokens: req.maxTokens ?? 32768 },
    aliyun_user_type: "personal_standard",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    model_config: {
      key: req.modelKey,
      display_name: req.displayName,
      model: "",
      format: "openai",
      is_vl: false,
      is_reasoning: req.reasoning ?? false,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: req.contextWindow ?? 180000,
    },
    messages: [
      ...(system
        ? [
            {
              role: "system",
              content: String(system.content ?? ""),
              response_meta: BLANK_RESPONSE_META,
              reasoning_content_signature: "",
            },
          ]
        : []),
      ...userMessages.map((m) => {
        const role = m.role === "assistant" ? "assistant" : "user";
        if (m.role === "tool") {
          // The tool's answer: a user turn that carries the call it belongs to.
          const call = callsById.get(String((m as any).tool_call_id ?? ""));
          const answer = textOf(m.content);
          return {
            role: "user",
            content: answer,
            response_meta: {
              ...BLANK_RESPONSE_META,
              tool_call: {
                id: (m as any).tool_call_id ?? "",
                type: "function",
                function: call?.function ?? { name: "", arguments: "" },
                content: answer,
              },
            },
            reasoning_content_signature: "",
          };
        }
        const toolCalls = (m as any).tool_calls ?? [];
        return {
          role,
          content: textOf(m.content),
          response_meta: {
            ...BLANK_RESPONSE_META,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          reasoning_content_signature: "",
        };
      }),
    ],
    tools: req.tools ?? [],
    business: {
      product: "cli",
      version: COSY_VERSION,
      type: "agent",
      id: crypto.randomUUID(),
      name: "hi",
      begin_at: Date.now(),
      stage: "start",
    },
  };
}

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

export interface LegacyRequestOptions {
  region?: QoderRegion;
  signal?: AbortSignal;
}

/**
 * Send a legacy request and hand back the upstream response. The body is
 * already encoded; the caller reads the private SSE format.
 */
export async function legacyChatCompletion(
  req: LegacyRequestBody,
  opts: LegacyRequestOptions = {},
): Promise<Response> {
  const region = opts.region ?? "global";
  const url =
    `${LEGACY_ENDPOINTS[region]}/algo/api/v2/service/pro/sse/agent_chat_generation` +
    `?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;

  const session = await buildSession(region);
  const raw = JSON.stringify(buildLegacyBody(req));
  const encoded = qoderBase64Encode(Buffer.from(raw, "utf8"));
  const headers = legacyHeaders(session, url, encoded);

  const r = await fetch(url, { method: "POST", headers, body: encoded, signal: opts.signal });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new AuthError(`legacy upstream HTTP ${r.status}`, `Qoder 老协议返回 ${r.status}：${text.slice(0, 300)}`, 502);
  }
  return r;
}

/**
 * One frame of the legacy stream, already unwrapped to a plain OpenAI chunk.
 */
export interface LegacyFrame {
  /** The OpenAI chunk, or undefined for a frame that carried no completion. */
  chunk?: Json;
  /** Set when the frame reported an error. */
  error?: { code?: string; message?: string; status?: number };
}

/**
 * Unwrap the private SSE format into plain OpenAI chunks.
 *
 * A frame is `data:{"headers":…,"body":"<json>"}`; the inner JSON is the chunk.
 * Errors come as their own frame with a `code` and a `message`.
 */
export async function* readLegacyFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<LegacyFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let outer: Json;
        try {
          outer = JSON.parse(payload);
        } catch {
          continue;
        }
        // The wrapper carries the upstream status alongside the payload, so a
        // status of 200 is the normal case, not a failure. When the status says
        // something went wrong, the reason is inside the body.
        const status = outer.statusCodeValue ?? (typeof outer.statusCode === "number" ? outer.statusCode : undefined);
        if (outer.code || (typeof status === "number" && status >= 400)) {
          let detail: Json = outer;
          if (typeof outer.body === "string") {
            try {
              detail = JSON.parse(outer.body);
            } catch {
              /* keep the wrapper */
            }
          }
          yield {
            error: {
              code: detail.code ?? outer.code,
              message: detail.message ?? outer.message,
              status,
            },
          };
          continue;
        }
        let inner = outer.body;
        if (typeof inner === "string") {
          try {
            inner = JSON.parse(inner);
          } catch {
            continue;
          }
        }
        if (inner && typeof inner === "object") {
          if (inner.error) {
            yield { error: { code: inner.error.code ?? inner.error.type, message: inner.error.message } };
            continue;
          }
          yield { chunk: inner };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
