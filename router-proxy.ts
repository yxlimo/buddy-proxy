// router-proxy.ts — the single entry point in front of both upstreams.
//
// One port, two dialects, two upstreams:
//
//   POST /v1/messages         Anthropic dialect
//   POST /v1/chat/completions  OpenAI dialect
//   GET  /v1/models            model catalog of both upstreams
//   GET  /health
//
// The model name decides the upstream. A prefix is explicit (`qoder/auto`,
// `minimax/MiniMax-M3`); without one the catalog is consulted, Qoder first,
// because it carries far more models.
//
// Each dialect is cheapest on the upstream that speaks it natively:
//   OpenAI  → Qoder    the Qoder gateway is an OpenAI endpoint, so it passes through
//   OpenAI  → MiniMax  converted to Anthropic on the way out
//   Anthropic → Qoder  converted to Anthropic on the way in
//   Anthropic → MiniMax passes through

import express from "express";
import crypto from "node:crypto";
import { authenticate, loadKeys, REQUIRE_API_KEY } from "./lib/api-keys.ts";
import { readEnvFlag, readEnvNumber, readEnvString } from "./lib/env.ts";
import { AuthError } from "./lib/credential.ts";
import { sseHead, writeSafe } from "./lib/sse.ts";
import { sseEvent } from "./lib/sse-stream.ts";
import { anthropicStreamToOpenAI, anthropicToOpenAI, anthropicToOpenAIResponse, effortFromBudget, openaiStreamToAnthropic, openaiToAnthropic, openaiToAnthropicResponse } from "./lib/dialect.ts";
import { readOpenAIChunks, sseData, SSE_DONE } from "./lib/sse-stream.ts";
import { anthropicModelsPayload, openaiModelsPayload, QODER_MODELS, qoderLabel, qoderModelsForRegion, qoderProtocolForRegion, resolveModelRoute, QODER_EFFORTS, QODER_MAX_OUTPUT_TOKENS, type QoderModel } from "./lib/qoder-models.ts";
import { MINIMAX_MODELS } from "./lib/minimax-models.ts";
import { qoderChatCompletion, LimitError } from "./lib/qoder-transport.ts";
import { legacyChatCompletion, readLegacyFrames } from "./lib/qoder-legacy.ts";
import { qoderStatus, checkAccountHealth, type QoderRegion } from "./lib/qoder-auth.ts";

const PORT = readEnvNumber("ROUTER_PORT", 6450);
const HOST = readEnvString("ROUTER_HOST", "0.0.0.0");
const MINIMAX_BASE = readEnvString("MINIMAX_UPSTREAM_URL", "http://127.0.0.1:6448").replace(/\/+$/, "");
const QODER_REGION = (readEnvString("QODER_REGION", "global").trim().toLowerCase() === "cn" ? "cn" : "global") as QoderRegion;
const PING_MS = readEnvNumber("MINIMAX_PING_MS", 15000);
// The legacy endpoint queues models and reports 429 while a request waits. The
// CLI retries these, so the proxy does too — with the same shape.
const LEGACY_MAX_ATTEMPTS = readEnvNumber("QODER_LEGACY_ATTEMPTS", 3);
const LEGACY_RETRY_MS = readEnvNumber("QODER_LEGACY_RETRY_MS", 10000);
const QODER_MAX_ATTEMPTS = readEnvNumber("QODER_MAX_ATTEMPTS", 3);
const LOG_ROUTE = readEnvFlag("QODER_LOG_ROUTE", false);

const rid = (prefix: string) => prefix + crypto.randomBytes(12).toString("hex");

type Dialect = "anthropic" | "openai";
type Upstream = "qoder" | "minimax";

const MINIMAX_MODEL_IDS = new Set(MINIMAX_MODELS.map((m) => m.id));
// Only the models each region can actually serve are advertised. The rest stay
// in the catalog so a request for one gets a clear "not available here"
// instead of being sent to an upstream that will not answer.
const QODER_GLOBAL = qoderModelsForRegion("global");
const QODER_CN = qoderModelsForRegion("cn");
const QODER_VISIBLE = qoderModelsForRegion(QODER_REGION);
const QODER_MODEL_IDS = new Set(QODER_VISIBLE.map((m) => m.id));
const QODER_HIDDEN_IDS = new Set(QODER_MODELS.filter((m) => !QODER_MODEL_IDS.has(m.id)).map((m) => m.id));
const GLOBAL_QODER_IDS = new Set(QODER_GLOBAL.map((m) => m.id));
const CN_QODER_IDS = new Set(QODER_CN.map((m) => m.id));

interface Route {
  upstream: Upstream;
  /** Model name as the upstream knows it (prefix stripped). */
  model: string;
  /** Which Qoder region to talk to. Unset for MiniMax. */
  region?: QoderRegion;
}

/** Decide where a request goes, and what the upstream should call the model. */
export function resolveRoute(model: string): Route {
  const raw = String(model ?? "").trim();
  if (raw.startsWith("qoder-cn/")) return qoderRoute(raw.slice("qoder-cn/".length), "cn");
  if (raw.startsWith("qoder/")) return qoderRoute(raw.slice("qoder/".length), "global");
  if (raw.startsWith("minimax/")) return { upstream: "minimax", model: raw.slice("minimax/".length) };
  // Client-side name for the CN region: the client cannot put a slash in a
  // model id, so `qoder-cn/glm-5.3` is called `cn-glm-5.3` there.
  if (raw.startsWith("cn-")) return qoderRoute(raw.slice("cn-".length), "cn");
  if (MINIMAX_MODEL_IDS.has(raw)) return { upstream: "minimax", model: raw };
  if (GLOBAL_QODER_IDS.has(raw)) return { upstream: "qoder", model: raw, region: "global" };
  if (CN_QODER_IDS.has(raw)) return { upstream: "qoder", model: raw, region: "cn" };
  if (QODER_HIDDEN_IDS.has(raw)) throw unavailableQoderModel(raw);
  throw new AuthError(
    `unknown model "${raw}"`,
    `这个模型不在目录里。用 qoder/ 或 minimax/ 前缀显式指定，例如 qoder/auto、minimax/MiniMax-M3。`,
    400,
  );
}

/** A model the catalog knows, but no region can serve. */
function unavailableQoderModel(id: string): AuthError {
  return new AuthError(
    `model "${id}" is not available`,
    `Qoder 的 ${id} 目前没有可用的区域：全球区的新协议不认它，老协议被限流/额度卡住；中国区把它排进了队列。可用：${[...GLOBAL_QODER_IDS].join("、")}（全球区），CN 前缀走中国区。`,
    400,
  );
}

function qoderRoute(id: string, region: QoderRegion): Route {
  const known = region === "cn" ? CN_QODER_IDS : GLOBAL_QODER_IDS;
  if (known.has(id)) return { upstream: "qoder", model: id, region };
  if (QODER_HIDDEN_IDS.has(id)) throw unavailableQoderModel(id);
  // Known to the other region but not to this one: point at it.
  const other = region === "cn" ? "global" : "cn";
  if ((region === "cn" ? GLOBAL_QODER_IDS : CN_QODER_IDS).has(id)) {
    throw new AuthError(
      `model "${id}" is not available in the ${region} region`,
      `这个模型只在 ${other} 区有。用 ${region === "cn" ? "qoder/" : "cn-"} 前缀指定另一个区域。`,
      400,
    );
  }
  throw new AuthError(
    `unknown model "${id}"`,
    `Qoder ${region} 区没有这个模型。可用：${[...known].join("、")}。`,
    400,
  );
}

const keys = loadKeys();
const app = express();
app.use(express.json({ limit: "64mb" }));

app.get("/health", async (_req, res) => {
  // The account's own standing is checked live: a valid token still means nothing
  // if the account is not allowed to make requests from here.
  let qoderHealth: Record<string, unknown>;
  try {
    qoderHealth = await checkAccountHealth(QODER_REGION);
  } catch (e) {
    qoderHealth = { region: QODER_REGION, usable: false, reason: (e as Error)?.message };
  }
  res.json({
    status: "ok",
    dialects: ["anthropic", "openai"],
    upstreams: {
      minimax: { base: MINIMAX_BASE, models: MINIMAX_MODELS.length },
      qoder: {
        region: QODER_REGION,
        models: QODER_VISIBLE.length,
        credential: qoderStatus(QODER_REGION),
        account: qoderHealth,
        regions: {
          global: { models: QODER_GLOBAL.length, credential: qoderStatus("global") },
          cn: { models: QODER_CN.length, credential: qoderStatus("cn") },
        },
      },
    },
    auth: REQUIRE_API_KEY ? "api-key" : "public",
  });
});

app.get("/v1/models", (req, res) => {
  const dialect = String(req.query.dialect ?? "").toLowerCase();
  if (dialect === "openai") return res.json(openaiCatalog());
  return res.json(anthropicCatalog());
});

/** OpenAI shape, with the prefixes that make routing explicit. */
function openaiCatalog() {
  const created = Math.floor(Date.now() / 1000);
  const data = [
    ...QODER_GLOBAL.map((m) => ({ id: `qoder/${m.id}`, object: "model", created, owned_by: "qoder", name: qoderLabel(m) })),
    ...QODER_CN.map((m) => ({ id: `qoder-cn/${m.id}`, object: "model", created, owned_by: "qoder-cn", name: qoderLabel(m) })),
    ...MINIMAX_MODELS.map((m) => ({ id: `minimax/${m.id}`, object: "model", created, owned_by: "minimax" })),
  ];
  return { object: "list", data };
}

/** Anthropic shape, with the extra metadata pi reads. */
function anthropicCatalog() {
  const created = Math.floor(Date.now() / 1000);
  const qoderEntry = (m: (typeof QODER_GLOBAL)[number], prefix: string) => ({
    id: `${prefix}${m.id}`,
    type: "model",
    display_name: qoderLabel(m),
    created_at: created,
    reasoning: m.reasoning,
    tool_call: true,
    context_window: m.context,
    max_output_tokens: QODER_MAX_OUTPUT_TOKENS,
    // A tier accepts a thinking level; a pinned model either thinks or does not,
    // and the list says which.
    ...(m.kind === "tier" ? { effort_options: [...QODER_EFFORTS] } : {}),
    ...(m.backend ? { backend: m.backend } : {}),
  });
  const data = [
    ...QODER_GLOBAL.map((m) => qoderEntry(m, "qoder/")),
    ...QODER_CN.map((m) => qoderEntry(m, "qoder-cn/")),
    ...MINIMAX_MODELS.map((m) => ({
      id: `minimax/${m.id}`,
      type: "model",
      display_name: m.display_name,
      created_at: created,
      reasoning: m.reasoning,
      tool_call: m.tool_call,
      context_window: m.context,
      max_output_tokens: m.output,
      effort_options: m.effortOptions,
    })),
  ];
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
    default_model: "qoder/auto",
  };
}

app.post("/v1/messages", async (req: express.Request, res: express.Response) => {
  if (!authenticate(req, keys)) {
    return res.status(401).json({ error: { type: "authentication_error", message: "invalid api key" } });
  }
  await handle(req, res, "anthropic");
});

app.post("/v1/chat/completions", async (req: express.Request, res: express.Response) => {
  if (!authenticate(req, keys)) {
    return res.status(401).json({ error: { type: "authentication_error", message: "invalid api key" } });
  }
  await handle(req, res, "openai");
});

async function handle(req: express.Request, res: express.Response, dialect: Dialect): Promise<void> {
  const body = (req.body ?? {}) as Record<string, any>;
  let route: Route;
  try {
    route = resolveRoute(body.model);
  } catch (e) {
    sendError(res, e);
    return;
  }

  const stream = body.stream === true;
  try {
    if (route.upstream === "qoder") {
      await toQoder(body, route, dialect, stream, res);
    } else {
      await toMinimax(body, route, dialect, stream, res);
    }
  } catch (e) {
    sendError(res, e);
  }
}

/* ---------------- Qoder ---------------- */

/**
 * The thinking level a request asks for.
 *
 * Several shapes reach the proxy, depending on the client and the dialect:
 *   `output_config.effort`  — the Anthropic spelling opencode and pi use
 *   `effort`                — explicit, and the only way to ask for `max`
 *   `reasoning_effort`      — the OpenAI spelling
 *   `thinking.budget_tokens` — the Anthropic spelling with a budget instead of a
 *                              level, where the level has to be recovered
 *
 * Qoder's own protocol has no per-request thinking switch: the tier *is* the
 * switch, so the level is translated into a tier here.
 */
function extractEffort(body: Record<string, any>): string | undefined {
  const candidates = [body.output_config?.effort, body.effort, body.reasoning_effort];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }

  const budget = body.thinking?.budget_tokens ?? body.thinking_budget_tokens ?? body.thinking_budget;
  if (typeof budget === "number" && budget > 0) return effortFromBudget(budget);
  return undefined;
}

async function toQoder(
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
): Promise<void> {
  // Qoder speaks OpenAI natively, so the request is either already OpenAI or is
  // converted once.
  const openaiBody = dialect === "openai" ? { ...body } : anthropicToOpenAI(body);
  openaiBody.stream = stream;

  // Read the effort from the original request: the dialect conversion drops the
  // Anthropic spelling (`output_config.effort`), and that is where opencode and
  // pi put it.
  const effort = extractEffort(body);
  const region = route.region ?? QODER_REGION;
  const { model, key } = resolveModelRoute(route.model, effort, region);
  if (LOG_ROUTE) {
    console.log(`[ROUTE] model=${route.model} region=${region} effort=${effort ?? "-"} -> upstream key=${key}`);
    console.log(`[ROUTE] raw body keys: ${Object.keys(body).join(",")}`);
    console.log(`[ROUTE] thinking=${JSON.stringify((body as any).thinking)} output_config=${JSON.stringify((body as any).output_config)}`);
  }
  if (model && qoderProtocolForRegion(model, region) === "legacy") {
    await toQoderLegacy(openaiBody, model, dialect, stream, res, region);
    return;
  }

  openaiBody.model = key;
  const upstream = await qoderWithRetry(
    () => qoderChatCompletion(openaiBody, { stream, region }),
    QODER_MAX_ATTEMPTS,
  );

  if (!stream) {
    const json = await upstream.json();
    // The gateway can answer 200 with an error object instead of a completion.
    if (json?.error) {
      const detail = json.error;
      throw new AuthError(
        `upstream error (${detail?.type ?? detail?.code ?? "unknown"})`,
        typeof detail?.message === "string" ? detail.message : JSON.stringify(detail).slice(0, 300),
        502,
      );
    }
    const payload = dialect === "openai" ? json : openaiToAnthropicResponse(json, route.model);
    res.json(payload);
    return;
  }

  // Peek before the headers go out, so an upstream failure inside a 200 response
  // can still become a proper status code.
  const upstreamStream = await peekStream(upstream.body!);
  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "openai") {
    // Same dialect on both sides: copy the bytes.
    await pipeStream(upstreamStream, res);
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(readOpenAIChunks(upstreamStream), route.model)) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    // The headers are already out, so the failure goes back as an error event.
    writeSafe(
      res,
      sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" },
      }),
    );
  }
  res.end();
}

/**
 * The legacy (COSY) protocol, for the models the new one refuses.
 *
 * Its response is Qoder's own frame format, so the frames are unwrapped into
 * plain OpenAI chunks and then converted like any other upstream. The non-
 * streaming case has no upstream equivalent, so the chunks are collected and
 * reassembled into one completion.
 */
async function toQoderLegacy(
  openaiBody: Record<string, any>,
  model: QoderModel,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
  region: QoderRegion,
): Promise<void> {
  const chunks = legacyWithRetry(
    () =>
      legacyChatCompletion(
        {
          messages: Array.isArray(openaiBody.messages) ? openaiBody.messages : [],
          tools: Array.isArray(openaiBody.tools) ? openaiBody.tools : undefined,
          modelKey: model.key,
          displayName: model.name,
          maxTokens: typeof openaiBody.max_tokens === "number" ? openaiBody.max_tokens : 4096,
          reasoning: model.reasoning,
          contextWindow: model.context,
        },
        { region },
      ),
    LEGACY_MAX_ATTEMPTS,
  );

  if (!stream) {
    const completion = await collectOpenAIChunks(chunks, model.id);
    const payload = dialect === "openai" ? completion : openaiToAnthropicResponse(completion, model.id);
    res.json(payload);
    return;
  }

  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "openai") {
    // Same dialect on both sides: re-emit the chunks as plain OpenAI SSE.
    try {
      for await (const chunk of chunks) {
        if (!writeSafe(res, sseData(chunk))) break;
      }
      writeSafe(res, SSE_DONE);
    } catch (e) {
      writeSafe(res, sseEvent("error", { error: { type: "api_error", message: (e as Error)?.message } }));
    }
    res.end();
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(chunks, model.id)) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    writeSafe(
      res,
      sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" },
      }),
    );
  }
  res.end();
}

/** Unwrap the legacy frames into plain OpenAI chunks, raising on error frames. */
async function* readLegacyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  for await (const frame of readLegacyFrames(body)) {
    if (frame.error) throw legacyError(frame.error);
    if (frame.chunk) yield frame.chunk;
  }
}

function legacyError(error: { code?: string; message?: string; status?: number }): AuthError {
  return new AuthError(
    `legacy upstream error (${error.code ?? "unknown"})`,
    `${error.message ?? "upstream failed"}${error.status ? ` (HTTP ${error.status})` : ""}`,
    error.status && error.status >= 500 ? 502 : 503,
  );
}

/**
 * The legacy endpoint answers 429 with `provider_error` / "All backends failed"
 * while the model is queued or the account is rate limited, and the CLI retries
 * such a request rather than failing it. The first frame tells us whether the
 * attempt was queued, so the retry happens before any bytes reach the client.
 */
async function* legacyWithRetry(
  send: () => Promise<Response>,
  maxAttempts: number,
): AsyncGenerator<Record<string, any>> {
  for (let attempt = 1; ; attempt++) {
    const upstream = await send();
    const frames = readLegacyFrames(upstream.body!)[Symbol.asyncIterator]();
    const first = await frames.next();

    if (!first.done && first.value.error && attempt < maxAttempts && isRetryableLegacy(first.value.error)) {
      await new Promise((r) => setTimeout(r, LEGACY_RETRY_MS));
      continue;
    }
    if (!first.done) {
      if (first.value.error) throw legacyError(first.value.error);
      if (first.value.chunk) yield first.value.chunk;
    }
    while (true) {
      const next = await frames.next();
      if (next.done) break;
      if (next.value.error) throw legacyError(next.value.error);
      if (next.value.chunk) yield next.value.chunk;
    }
    return;
  }
}

function isRetryableLegacy(error: { code?: string; status?: number }): boolean {
  return error.status === 429 || error.code === "provider_error";
}

/**
 * The upstream answers 403/429 when the model is queued or every backend for it
 * is busy — the CLI retries these, so the proxy does too. The request has not
 * produced any bytes yet, so the retry is invisible to the client.
 */
async function qoderWithRetry(send: () => Promise<Response>, maxAttempts: number): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      if (e instanceof LimitError && attempt < maxAttempts) {
        if (LOG_ROUTE) console.log(`[ROUTE] upstream busy, retry ${attempt}/${maxAttempts - 1} in ${e.retryAfterSec}s`);
        await new Promise((r) => setTimeout(r, e.retryAfterSec * 1000));
        continue;
      }
      throw e;
    }
  }
}

/** Collect a chunk stream into a single chat completion. */
async function collectOpenAIChunks(
  chunks: AsyncGenerator<Record<string, any>>,
  model: string,
): Promise<Record<string, any>> {
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const toolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let usage: Record<string, any> | undefined;

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof call.index === "number" ? call.index : 0;
      const existing = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.function.name = call.function.name;
      if (typeof call.function?.arguments === "string") existing.function.arguments += call.function.arguments;
      toolCalls.set(index, existing);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message: Record<string, any> = { role: "assistant", content: toolCalls.size ? null : content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].map(([index, call]) => ({ index, ...call }));

  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage: usage
      ? {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/* ---------------- MiniMax ---------------- */

async function toMinimax(
  body: Record<string, any>,
  route: Route,
  dialect: Dialect,
  stream: boolean,
  res: express.Response,
): Promise<void> {
  // MiniMax speaks Anthropic natively.
  const anthropicBody = dialect === "anthropic" ? { ...body } : openaiToAnthropic(body);
  anthropicBody.model = route.model;
  anthropicBody.stream = stream;

  const r = await fetch(`${MINIMAX_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "anthropic-version": body.anthropic_version ?? "2023-06-01",
    },
    body: JSON.stringify(anthropicBody),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new AuthError(`upstream HTTP ${r.status}`, `MiniMax 上游返回 ${r.status}：${text.slice(0, 300)}`, 502);
  }

  if (!stream) {
    const json = await r.json();
    const payload = dialect === "anthropic" ? json : anthropicToOpenAIResponse(json, route.model);
    res.json(payload);
    return;
  }

  res.setHeader("x-request-id", rid("req_"));
  sseHead(res);
  if (dialect === "anthropic") {
    await pipeStream(r.body!, res);
    return;
  }
  try {
    for await (const chunk of anthropicStreamToOpenAI(r.body!, route.model)) {
      if (!writeSafe(res, chunk)) break;
    }
  } catch (e) {
    writeSafe(
      res,
      sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: (e as Error)?.message ?? "upstream failed" },
      }),
    );
  }
  res.end();
}

/* ---------------- plumbing ---------------- */

/**
 * Look at the first chunk before committing to a 200 response.
 *
 * The gateway can report a failure inside a 200 response (an SSE error event, or
 * a 429 body). If the headers were already sent there is no way to turn that into
 * a proper status code, so the check happens first.
 */
async function peekStream(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done) {
    reader.releaseLock();
    return body;
  }
  const head = new TextDecoder().decode(first.value);
  if (head.includes('"error"') || head.includes("errorCode")) {
    const rest = await new Response(body).text();
    let message = rest.slice(0, 300);
    try {
      const parsed = JSON.parse(rest);
      const detail = parsed?.error ?? parsed;
      message = detail?.message ?? parsed?.message ?? message;
    } catch {
      /* keep the raw text */
    }
    throw new AuthError("upstream rejected the request", message, 502);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}

async function pipeStream(body: ReadableStream<Uint8Array>, res: express.Response): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!writeSafe(res, Buffer.from(value))) break;
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

function sendError(res: express.Response, e: unknown): void {
  const err = e as AuthError;
  if (e instanceof LimitError) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(503).json({
      error: { type: "api_error", message: err.message },
      hint: err.detail,
    });
    return;
  }
  const status = typeof err?.status === "number" ? err.status : 500;
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({
    error: {
      // 503 means the credential is the problem; everything else is the request
      // or the upstream failing.
      type: status === 503 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error",
      message: err?.message ?? "request failed",
    },
    ...(err?.hint ? { hint: err.hint } : {}),
  });
}

app.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
  console.log("");
  console.log(`  router listening on ${base}`);
  console.log(`    Anthropic  ${base}/v1/messages`);
  console.log(`    OpenAI     ${base}/v1/chat/completions`);
  console.log(`    Models     ${base}/v1/models`);
  console.log(`    Health     ${base}/health`);
  console.log("");
  console.log(`  upstreams:`);
  console.log(`    qoder    global=${QODER_GLOBAL.length}  cn=${QODER_CN.length}`);
  console.log(`    minimax  ${MINIMAX_BASE}  models=${MINIMAX_MODELS.length}`);
  console.log(`  auth: ${REQUIRE_API_KEY ? "api key required" : "public"}`);
  console.log("");
  void PING_MS;
});
