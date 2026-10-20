// v2-proxy.ts — OpenCode free models as OpenAI/Anthropic APIs (opencode v2 API).
//
// Endpoint layout — the two dialects are split by URL prefix (like
// DeepSeek / MiniMax), never by header negotiation, so the models endpoints
// can't collide on one path:
//
//   OpenAI:     GET  /v1/models              → OpenAI shape
//               POST /v1/chat/completions
//   Anthropic:  GET  /anthropic/v1/models    → Anthropic shape
//               POST /anthropic/v1/messages
//               (Anthropic clients pass baseURL .../anthropic and their SDK
//                appends /v1/*, exactly like api.deepseek.com/anthropic)
//
// Port of v1-proxy.mjs (v1 `opencode serve` API: /session/{id}/message blocks,
// /event SSE carries `message.part.delta`) to the v2 API served by
// opencode >= 2.0.x:
//
//   - GET  /api/model                    model list (v1: models live on /provider)
//   - POST /api/session {model:{...}}     session created with its model
//   - POST /api/session/{id}/prompt {text}  async enqueue, returns immediately
//   - GET  /api/session/{id}/message      poll {data:[]} until assistant.finish
//   - DELETE /api/session/{id}            cleanup
//
// Because the v2 prompt call does not block and its /api/event stream uses
// new event names (`session.reasoning.delta`, …) whose text-delta naming is
// not stable across builds, streaming is implemented by polling
// /api/session/{id}/message and forwarding the growth of `content[]` —
// protocol-independent and correct regardless of event schema churn.
//
// Usage:
//   node v2-proxy.ts                      # auto-spawns `opencode serve`
//   OC_SERVER=http://127.0.0.1:13284 \
//   OC_PASSWORD=pass node v2-proxy.ts
//
// Env:
//   PROXY_PORT   port for this proxy          (default 6447)
//   OC_BIN       path to opencode binary      (default ~/.opencode/bin/opencode)
//   OC_WORKDIR   working dir for the agent    (default ./oc-workspace)
//   OC_SERVER    reuse an existing opencode serve instance
//   OC_USERNAME  basic-auth user for OC_SERVER (default "opencode")
//   OC_PASSWORD  basic-auth password for OC_SERVER
//   OC_TIMEOUT   per-request timeout in sec   (default 600)
//   KEYS_FILE    API keys file                (default ./api-keys.json)
//   OPENCODE_ZEN_PROXY_SHOW_FREE  filter /v1/models to *free* ids (see free-features.ts)
//   REQUIRE_API_KEY  require a valid api-keys.json key (default off = public;
//                    any key / blank passes. ZEN free is gated by the
//                    opencode binary's own login, not a client key)
//
// Session behavior (same as v1):
//   - Header `x-oc-session: <name>` (or OpenAI `user` field, or Anthropic
//     metadata.user_id) → persistent multi-turn conversation.
//   - Without a key, every request is a fresh session replaying the whole
//     transcript, deleted right after the reply.
//
// Limitation: client-supplied `tools` schemas are not forwarded; the opencode
// agent runs its own built-in tools (read/edit/bash) server-side and folds
// results into the reply text.

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadShowFree, loadRequireApiKey, filterFreeModels, saveFreeModels } from "./free-features.ts";
import { authenticate, loadKeys } from "./lib/api-keys.ts";
import { readEnvNumber, readEnvString } from "./lib/env.ts";
import { rid, sseHead, writeSafe, type SinkRes } from "./lib/sse.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY_PORT = readEnvNumber("PROXY_PORT", 6447);
const OC_SERVER = readEnvString("OC_SERVER", "");
const OC_USERNAME = readEnvString("OC_USERNAME", "opencode");
const OC_PASSWORD = readEnvString("OC_PASSWORD", "");
const OC_BIN = readEnvString("OC_BIN", "") || findBinary();
const OC_WORKDIR = readEnvString("OC_WORKDIR", path.join(HERE, "oc-workspace"));
const REQUEST_TIMEOUT = readEnvNumber("OC_TIMEOUT", 600) * 1000;
const POLL_MS = 250;
const SHOW_FREE = loadShowFree();
const REQUIRE_API_KEY = loadRequireApiKey();
const FREE_LIST_SOURCE = `http://127.0.0.1:${PROXY_PORT}/v1/models`;

function findBinary(): string {
  const candidates = [
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "opencode";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── API keys (shared front door: lib/api-keys.ts) ────────────────────
// Public mode (default): ZEN free access is gated by the opencode binary's own
// login, not by a client key — so any key, or none, passes.
const apiKeys = loadKeys();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function auth(req: any): string | null {
  return authenticate(req, apiKeys);
}

// ── opencode serve backend (v2 API) ─────────────────────────────────
let ocBase: string | null = null;
let ocAuth: string | null = null;

function ocReq(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL((ocBase as string) + pathname);
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: {
          ...(ocAuth ? { Authorization: ocAuth } : {}),
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
        },
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* keep raw */
          }
          resolve({ status: res.statusCode ?? 0, json, raw });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("opencode request timed out"));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function startBackend(): Promise<void> {
  if (OC_SERVER) {
    ocBase = OC_SERVER.replace(/\/$/, "");
    ocAuth = OC_PASSWORD
      ? "Basic " + Buffer.from(`${OC_USERNAME}:${OC_PASSWORD}`).toString("base64")
      : null;
    return;
  }
  if (OC_BIN === "opencode" && !fs.existsSync("/usr/bin/opencode")) {
    try {
      const { execSync } = await import("node:child_process");
      execSync("command -v opencode", { stdio: "ignore" });
    } catch {
      throw new Error("opencode binary not found — set OC_BIN or install opencode");
    }
  }
  fs.mkdirSync(OC_WORKDIR, { recursive: true });
  const password = "oc-" + crypto.randomBytes(12).toString("hex");
  const child = spawn(OC_BIN, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    cwd: OC_WORKDIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("exit", (code) => console.log("[OC] opencode serve exited with code", code));
  process.on("exit", () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  });

  const port: string = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("opencode serve did not start within 45s")), 45000);
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/listening on https?:\/\/[^:]+:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`opencode serve exited early (code ${c})`));
    });
  });
  ocBase = `http://127.0.0.1:${port}`;
  ocAuth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  console.log(`[OC] opencode serve backend on ${ocBase}`);

  for (let i = 0; i < 60; i++) {
    try {
      const r = await ocReq("GET", "/api/model");
      if (r.status === 200) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error("opencode serve did not become healthy");
}

// ── models (v2: GET /api/model, filtered by SHOW_FREE) ──────────────
// Model metadata kept beyond ids: reasoning capability (thinking), context
// window, output cap, and the effort variants the model actually declares —
// opencode rejects unknown variants at run time (VariantUnavailableError),
// so effort requests must be validated/clamped against this list.
type ModelMeta = {
  id: string;
  name?: string; // human display name from /api/model (Anthropic display_name)
  released?: number; // epoch ms (time.released) → Anthropic created_at
  reasoning: boolean;
  context?: number;
  output?: number;
  efforts: string[]; // declared variant ids, e.g. ["low","medium","high",...]
  raw: Record<string, unknown>; // original ZEN (opencode /api/model) entry, kept for the snapshot
};

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

let modelMeta: Map<string, ModelMeta> | null = null;

async function getModelMeta(): Promise<Map<string, ModelMeta>> {
  if (modelMeta) return modelMeta;
  const r = await ocReq("GET", "/api/model");
  if (r.status !== 200 || !r.json?.data) throw new Error("failed to list opencode models");
  const entries = r.json.data as Array<{
    providerID?: string;
    modelID?: string;
    id?: string;
    name?: string;
    time?: { released?: number };
    compatibility?: { reasoningField?: string } | null;
    limit?: { context?: number; output?: number };
    variants?: Array<{ id?: string }> | null;
  }>;
  let picked = entries.filter((m) => m.providerID === "opencode");
  if (SHOW_FREE) {
    const keep = new Set(filterFreeModels(picked.map((m) => m.modelID || m.id || "")));
    picked = picked.filter((m) => keep.has(m.modelID || m.id || ""));
  }
  const map = new Map<string, ModelMeta>();
  for (const m of picked) {
    const id = m.modelID || m.id || "";
    if (!id) continue;
    map.set(id, {
      id,
      name: m.name,
      released: m.time?.released,
      reasoning: !!m.compatibility?.reasoningField,
      context: m.limit?.context,
      output: m.limit?.output,
      efforts: (m.variants || []).map((v) => v.id || "").filter(Boolean),
      raw: m as Record<string, unknown>,
    });
  }
  if (!map.size) throw new Error("no opencode models found");
  // First startup fetch → snapshot id + display_name + both API shapes + the raw ZEN entry.
  if (SHOW_FREE)
    saveFreeModels(
      [...map.values()].map((m) => ({
        id: m.id,
        display_name: m.name || m.id,
        openai: toOpenaiModel(m),
        anthropic: toAnthropicModel(m),
        zen_raw: m.raw,
      })),
      FREE_LIST_SOURCE,
    );
  modelMeta = map;
  return map;
}

/** ModelMeta → OpenAI `GET /v1/models` object (plus the complete extras). */
function toOpenaiModel(m: ModelMeta) {
  return {
    id: m.id,
    object: "model" as const,
    created: m.released ?? 0,
    owned_by: "opencode",
    // complete metadata kept beyond the OpenAI base fields
    display_name: m.name || m.id,
    reasoning: m.reasoning,
    context_length: m.context ?? null,
    max_output_tokens: m.output ?? null,
    efforts: m.efforts,
  };
}

/** ModelMeta → Anthropic `GET /v1/models` object (plus the complete extras). */
function toAnthropicModel(m: ModelMeta) {
  return {
    type: "model" as const,
    id: m.id,
    display_name: m.name || m.id,
    created_at: new Date(m.released ?? 0).toISOString(),
    // complete metadata kept beyond the Anthropic base fields
    reasoning: m.reasoning,
    context_length: m.context ?? null,
    max_output_tokens: m.output ?? null,
    efforts: m.efforts,
  };
}

async function getModels(): Promise<string[]> {
  return [...(await getModelMeta()).keys()];
}

/** pi thinking budget → effort level (DEFAULT_THINKING_BUDGETS in pi-ai). */
function budgetToEffort(budget?: number): string | null {
  if (!budget || budget <= 0) return null;
  if (budget <= 1024) return "minimal";
  if (budget <= 2048) return "low";
  if (budget <= 8192) return "medium";
  return "high";
}

/**
 * Clamp a requested effort to what the model declares. Returns the variant id
 * to pass on session create, or null for "no variant" (model default).
 */
function resolveVariant(meta: ModelMeta, effort: string | null): string | null {
  if (!effort || !meta.efforts.length) return null;
  const want = EFFORT_ORDER.includes(effort) ? effort : "medium";
  if (meta.efforts.includes(want)) return want;
  // nearest declared level at or below the request
  const idx = EFFORT_ORDER.indexOf(want);
  for (let i = idx - 1; i >= 0; i--) if (meta.efforts.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  return meta.efforts[0] ?? null;
}

// ── translation: chat formats → opencode prompt ─────────────────────
type Extracted = {
  text: string;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  finish?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => {
        if (c.type === "text") return c.text ?? "";
        if (c.type === "tool_result")
          return typeof c.content === "string"
            ? c.content
            : Array.isArray(c.content)
              ? c.content.map((x: any) => x.text || "").join("\n")
              : "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function messagesToPrompt(messages: any[]) {
  let system = "";
  const turns: string[] = [];
  for (const m of messages || []) {
    if (m.role === "system") system += (system ? "\n\n" : "") + extractText(m.content);
    else turns.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${extractText(m.content)}`);
  }
  const lastUserText =
    [...turns].reverse().find((t) => t.startsWith("User:"))?.slice(6) ?? "";
  return { system, transcript: turns.join("\n\n"), lastUserText };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anthropicToPrompt(body: any) {
  const system =
    typeof body.system === "string" ? body.system : extractText(body.system);
  const { transcript, lastUserText } = messagesToPrompt(body.messages);
  return { system, transcript, lastUserText };
}

// ── v2 sessions: async prompt + poll ────────────────────────────────
const sessions = new Map<
  string,
  { sessionID: string | null; turns: number; chain: Promise<unknown>; variant: string | null }
>();
function sessionEntry(key: string) {
  if (!sessions.has(key))
    sessions.set(key, { sessionID: null, turns: 0, chain: Promise.resolve(), variant: null });
  return sessions.get(key) as {
    sessionID: string | null;
    turns: number;
    chain: Promise<unknown>;
    variant: string | null;
  };
}

function upstreamError(r: { status: number; json: any }): Error {
  const msg =
    r.json?.data?.message ||
    r.json?.error?.message ||
    r.json?.message ||
    `opencode server returned ${r.status}`;
  return withStatus(msg, r.status);
}

function withStatus(message: string, status?: number): Error & { status?: number } {
  const e = new Error(message) as Error & { status?: number };
  e.status =
    status === 429 ? 429 : status === 400 ? 400 : status === 401 ? 401 : 502;
  return e;
}

// v2 assistant message shape
type V2Content = { type?: string; text?: string };
type V2Message = {
  id?: string;
  type?: string;
  time?: { created?: number; completed?: number };
  text?: string;
  content?: V2Content[];
  finish?: string;
  error?: { type?: string; message?: string; status?: number };
  tokens?: { input?: number; output?: number; reasoning?: number };
};

function extractV2(m: V2Message): Extracted {
  let text = "";
  let reasoning = "";
  for (const c of m.content || []) {
    if (c.type === "text") text += c.text ?? "";
    else if (c.type === "reasoning") reasoning += c.text ?? "";
  }
  return {
    text,
    reasoning,
    inputTokens: m.tokens?.input ?? 0,
    outputTokens: m.tokens?.output ?? 0,
    finish: m.finish,
  };
}

async function createSession(modelId: string, variant: string | null = null): Promise<string> {
  const model: Record<string, unknown> = { providerID: "opencode", id: modelId };
  if (variant) model.variant = variant;
  const r = await ocReq("POST", "/api/session", { model });
  const sid = r.json?.id ?? r.json?.data?.id;
  if (r.status !== 200 || !sid) throw upstreamError(r);
  return sid;
}

function deleteSession(sid: string) {
  ocReq("DELETE", `/api/session/${sid}`).catch((e: Error) =>
    console.log(`[OC] temp session ${sid} not deleted:`, e.message),
  );
}

/** Poll messages until the assistant reply for this prompt finishes. */
async function waitForReply(
  sid: string,
  promptAt: number,
  onDelta?: (partial: Extracted) => void,
): Promise<Extracted> {
  const deadline = Date.now() + REQUEST_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const r = await ocReq("GET", `/api/session/${sid}/message`);
    if (r.status !== 200) throw upstreamError(r);
    const data = (r.json?.data || []) as V2Message[];
    const mine = data.filter((m) => (m.time?.created ?? 0) >= promptAt - 2000);
    const asst = mine
      .filter((m) => m.type === "assistant")
      .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0];
    if (asst && asst.finish) {
      if (asst.finish === "error" || asst.error) {
        throw withStatus(asst.error?.message || "opencode run failed", asst.error?.status);
      }
      return extractV2(asst);
    }
    if (asst && onDelta) onDelta(extractV2(asst));
    const idle = mine.find((m) => m.type === "idle" && m.error);
    if (idle?.error && !asst) throw withStatus(idle.error.message || "opencode run failed", idle.error.status);
  }
  throw new Error("opencode request timed out");
}

async function ask(opts: {
  key: string | null;
  system: string;
  modelId: string;
  /** opencode variant (effort level) for this request, already clamped to the model. */
  variant: string | null;
  transcript: string;
  lastUserText: string;
  onDelta?: (partial: Extracted) => void;
}): Promise<Extracted> {
  const { key, system, modelId, variant, transcript, lastUserText, onDelta } = opts;
  // v2 prompt is plain text only — fold the system prompt into the replay.
  const payload = [system, transcript || lastUserText].filter(Boolean).join("\n\n");

  if (!key) {
    // stateless: fresh session per request, deleted as soon as the reply lands.
    if (variant) console.log(`[OC] session variant=${variant} model=${modelId}`);
    const sid = await createSession(modelId, variant);
    try {
      const promptAt = Date.now();
      const p = await ocReq("POST", `/api/session/${sid}/prompt`, { text: payload });
      if (p.status !== 200) throw upstreamError(p);
      return await waitForReply(sid, promptAt, onDelta);
    } finally {
      deleteSession(sid);
    }
  }

  // stateful: one opencode session per key; first turn replays the transcript,
  // later turns send only the newest user message.
  const entry = sessionEntry(key);
  const run = (async (): Promise<Extracted> => {
    // opencode bakes the variant into the session; if the requested effort
    // changes mid-conversation, rebuild the session and replay the transcript.
    if (entry.sessionID && entry.variant !== variant) {
      deleteSession(entry.sessionID);
      entry.sessionID = null;
      entry.turns = 0;
    }
    if (!entry.sessionID) {
      entry.sessionID = await createSession(modelId, variant);
      entry.variant = variant;
      entry.turns = 0;
    }
    const text = entry.turns === 0 ? payload : lastUserText;
    entry.turns++;
    const promptAt = Date.now();
    const p = await ocReq("POST", `/api/session/${entry.sessionID}/prompt`, { text });
    if (p.status !== 200) throw upstreamError(p);
    return waitForReply(entry.sessionID, promptAt, onDelta);
  })();
  entry.chain = run.catch(() => {});
  return run;
}

// ── sinks: OpenAI / Anthropic response writers (shared with v1) ─────
function mapFinish(finish?: string): string {
  return finish === "length" ? "length" : "stop";
}

// rid / writeSafe / sseHead / SinkRes now live in lib/sse.ts, shared with
// minimax-proxy.ts.

type Sink = {
  opened: boolean;
  delta(kind: "reasoning" | "text", text: string): void;
  finish(r: Extracted): void;
  fail(message: string): void;
};

function openaiResponse(modelId: string, r: Extracted) {
  return {
    id: rid("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: r.text,
          ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
        },
        finish_reason: mapFinish(r.finish),
      },
    ],
    usage: {
      prompt_tokens: r.inputTokens,
      completion_tokens: r.outputTokens,
      total_tokens: r.inputTokens + r.outputTokens,
    },
  };
}

function openaiSink(res: SinkRes, modelId: string): Sink {
  const id = rid("chatcmpl-");
  const created = Math.floor(Date.now() / 1000);
  let opened = false;
  let sentText = "";
  let sentReasoning = "";
  const chunk = (delta: Record<string, unknown>, finish?: string | null, usage?: unknown) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  const open = (): boolean => {
    if (opened) return true;
    if (res.writableEnded || res.destroyed) return false;
    opened = true;
    sseHead(res);
    writeSafe(res, chunk({ role: "assistant" }));
    return true;
  };
  const rest = (full: string, sent: string) =>
    !sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "";
  return {
    get opened() {
      return opened;
    },
    delta(kind, text) {
      if (!open()) return;
      if (kind === "reasoning") {
        sentReasoning += text;
        writeSafe(res, chunk({ reasoning_content: text }));
      } else {
        sentText += text;
        writeSafe(res, chunk({ content: text }));
      }
    },
    finish(r) {
      if (!open()) return;
      const reasoning = rest(r.reasoning, sentReasoning);
      const text = rest(r.text, sentText);
      if (reasoning) writeSafe(res, chunk({ reasoning_content: reasoning }));
      if (text) writeSafe(res, chunk({ content: text }));
      writeSafe(
        res,
        chunk({}, mapFinish(r.finish), {
          prompt_tokens: r.inputTokens,
          completion_tokens: r.outputTokens,
          total_tokens: r.inputTokens + r.outputTokens,
        }),
      );
      writeSafe(res, "data: [DONE]\n\n");
      try {
        res.end();
      } catch {
        /* ignore */
      }
    },
    fail(message) {
      if (!open()) return;
      writeSafe(res, `data: ${JSON.stringify({ error: { message } })}\n\n`);
      writeSafe(res, "data: [DONE]\n\n");
      try {
        res.end();
      } catch {
        /* ignore */
      }
    },
  };
}

function anthropicResponse(modelId: string, r: Extracted) {
  const content: unknown[] = [];
  if (r.reasoning) content.push({ type: "thinking", thinking: r.reasoning, signature: "" });
  content.push({ type: "text", text: r.text });
  return {
    id: rid("msg_"),
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: r.finish === "length" ? "max_tokens" : "end_turn",
    usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
  };
}

function anthropicSink(res: SinkRes, modelId: string): Sink {
  const id = rid("msg_");
  let opened = false;
  let block: string | null = null;
  let index = -1;
  let sentText = "";
  let sentReasoning = "";
  const send = (event: string, data: unknown) =>
    writeSafe(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const openBlock = (type: string) => {
    if (block === type) return;
    if (block) send("content_block_stop", { type: "content_block_stop", index });
    index += 1;
    block = type;
    send("content_block_start", {
      type: "content_block_start",
      index,
      content_block:
        type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    });
  };
  const open = (): boolean => {
    if (opened) return true;
    if (res.writableEnded || res.destroyed) return false;
    opened = true;
    sseHead(res);
    send("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model: modelId,
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    return true;
  };
  const rest = (full: string, sent: string) =>
    !sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "";
  const emit = (type: string, text: string) => {
    openBlock(type);
    send("content_block_delta", {
      type: "content_block_delta",
      index,
      delta:
        type === "thinking" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text },
    });
  };
  return {
    get opened() {
      return opened;
    },
    delta(kind, text) {
      if (!open()) return;
      if (kind === "reasoning") {
        sentReasoning += text;
        emit("thinking", text);
      } else {
        sentText += text;
        emit("text", text);
      }
    },
    finish(r) {
      if (!open()) return;
      const reasoning = rest(r.reasoning, sentReasoning);
      const text = rest(r.text, sentText);
      if (reasoning) {
        sentReasoning += reasoning;
        emit("thinking", reasoning);
      }
      if (text) {
        sentText += text;
        emit("text", text);
      }
      if (block) send("content_block_stop", { type: "content_block_stop", index });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: r.finish === "length" ? "max_tokens" : "end_turn" },
        usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
      });
      send("message_stop", { type: "message_stop" });
      try {
        res.end();
      } catch {
        /* ignore */
      }
    },
    fail(message) {
      if (!open()) return;
      send("error", { type: "error", error: { type: "api_error", message } });
      try {
        res.end();
      } catch {
        /* ignore */
      }
    },
  };
}

// ── HTTP API ────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app: any = express();
app.use(express.json({ limit: "10mb" }));

// Routes are split by URL prefix (like DeepSeek/MiniMax), not by header
// negotiation — OpenAI lives under /v1, Anthropic under /anthropic/v1, so the
// two models endpoints can never collide on the same path.

/** OpenAI `GET /v1/models` — OpenAI shape only. */
app.get("/v1/models", async (req: any, res: any) => {
  if (!auth(req)) return res.status(401).json({ error: { message: "Invalid API key" } });
  try {
    const meta = await getModelMeta();
    res.json({ object: "list", data: [...meta.values()].map(toOpenaiModel) });
  } catch (e) {
    res.status(502).json({ error: { message: (e as Error).message, type: "upstream_error" } });
  }
});

/** Anthropic `GET /v1/models` (mounted under /anthropic) — Anthropic shape only. */
app.get("/anthropic/v1/models", async (req: any, res: any) => {
  if (!auth(req))
    return res
      .status(401)
      .json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  try {
    const meta = await getModelMeta();
    const data = [...meta.values()].map(toAnthropicModel);
    res.json({
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    });
  } catch (e) {
    res.status(502).json({ type: "error", error: { type: "api_error", message: (e as Error).message } });
  }
});

/** Best-effort read of the effort level from either API dialect. */
function effortFromOpenAI(body: any): string | null {
  return body?.reasoning_effort || body?.reasoning?.effort || null;
}
function effortFromAnthropic(body: any): string | null {
  // adaptive-thinking models: output_config.effort
  if (body?.output_config?.effort) return body.output_config.effort;
  // budget-based thinking: map the budget back to a level
  const t = body?.thinking;
  if (t?.type === "enabled") return budgetToEffort(t.budget_tokens);
  if (t?.type === "adaptive" && t?.effort) return t.effort;
  return null;
}

app.post("/v1/chat/completions", async (req: any, res: any) => {
  if (!auth(req)) return res.status(401).json({ error: { message: "Invalid API key" } });
  let sink: Sink | null = null;
  try {
    const { model, messages, stream, user: userId } = req.body || {};
    const modelId = String(model || "").replace(/^opencode\//, "");
    const models = await getModels();
    if (!models.includes(modelId)) {
      return res.status(400).json({
        error: { message: `Unknown model: ${modelId}. Available: ${models.join(", ")}` },
      });
    }
    const { system, transcript, lastUserText } = messagesToPrompt(messages);
    if (!lastUserText) return res.status(400).json({ error: { message: "No user message in request" } });
    const key = req.headers["x-oc-session"] || userId || null;
    const meta = (await getModelMeta()).get(modelId)!;
    const variant = resolveVariant(meta, effortFromOpenAI(req.body));

    // track what the sink already emitted so poll growth maps to deltas
    let sentT = "";
    let sentR = "";
    const rest = (full: string, sent: string) =>
      !sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "";
    if (stream) {
      sink = openaiSink(res, modelId);
      res.on("close", () => {
        /* writeSafe guards writes after close */
      });
    }
    const onDelta =
      sink &&
      ((partial: Extracted) => {
        const dt = rest(partial.text, sentT);
        const dr = rest(partial.reasoning, sentR);
        if (dt) {
          sentT += dt;
          sink!.delta("text", dt);
        }
        if (dr) {
          sentR += dr;
          sink!.delta("reasoning", dr);
        }
      });

    const r = await ask({ key, system, modelId, variant, transcript, lastUserText, onDelta: onDelta ?? undefined });
    if (!r.text && !r.reasoning && !(sink && sink.opened)) {
      throw new Error("empty response from opencode");
    }
    if (stream && sink) return sink.finish(r);
    return res.json(openaiResponse(modelId, r));
  } catch (e) {
    const err = e as Error & { status?: number };
    if (sink && sink.opened) return sink.fail(err.message);
    return res
      .status(err.status || 502)
      .json({ error: { message: err.message, type: "upstream_error" } });
  }
});

/** Anthropic `POST /v1/messages` (mounted under /anthropic). */
app.post("/anthropic/v1/messages", async (req: any, res: any) => {
  if (!auth(req))
    return res
      .status(401)
      .json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  let sink: Sink | null = null;
  try {
    const { model, stream, metadata } = req.body || {};
    const modelId = String(model || "").replace(/^opencode\//, "");
    const models = await getModels();
    if (!models.includes(modelId)) {
      return res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Unknown model: ${modelId}. Available: ${models.join(", ")}`,
        },
      });
    }
    const { system, transcript, lastUserText } = anthropicToPrompt(req.body);
    if (!lastUserText) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "No user message in request" },
      });
    }
    const key = req.headers["x-oc-session"] || metadata?.user_id || null;
    const meta = (await getModelMeta()).get(modelId)!;
    const variant = resolveVariant(meta, effortFromAnthropic(req.body));

    let sentT = "";
    let sentR = "";
    const rest = (full: string, sent: string) =>
      !sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "";
    if (stream) sink = anthropicSink(res, modelId);
    const onDelta =
      sink &&
      ((partial: Extracted) => {
        const dt = rest(partial.text, sentT);
        const dr = rest(partial.reasoning, sentR);
        if (dt) {
          sentT += dt;
          sink!.delta("text", dt);
        }
        if (dr) {
          sentR += dr;
          sink!.delta("reasoning", dr);
        }
      });

    const r = await ask({ key, system, modelId, variant, transcript, lastUserText, onDelta: onDelta ?? undefined });
    if (!r.text && !r.reasoning && !(sink && sink.opened)) {
      throw new Error("empty response from opencode");
    }
    if (stream && sink) return sink.finish(r);
    return res.json(anthropicResponse(modelId, r));
  } catch (e) {
    const err = e as Error & { status?: number };
    if (sink && sink.opened) return sink.fail(err.message);
    return res.status(err.status || 502).json({
      type: "error",
      error: {
        type: err.status === 429 ? "rate_limit_error" : "upstream_error",
        message: err.message,
      },
    });
  }
});

app.get("/health", (_req: any, res: any) =>
  res.json({
    status: "ok",
    opencode: ocBase,
    models: modelMeta ? modelMeta.size : 0,
    showFree: SHOW_FREE,
    auth: REQUIRE_API_KEY ? "required" : "public",
  }),
);

// ── start ───────────────────────────────────────────────────────────
app.listen(PROXY_PORT, "0.0.0.0", async () => {
  // resolve the local address for display (best-effort: first non-internal IPv4)
  const os = await import("os");
  const ifaces = os.networkInterfaces();
  let lanIp: string | null = null;
  for (const entries of Object.values(ifaces)) {
    for (const e of entries || []) {
      if (e.family === "IPv4" && !e.internal) {
        lanIp = e.address;
        break;
      }
    }
    if (lanIp) break;
  }

  const base = `http://127.0.0.1:${PROXY_PORT}`;
  console.log("");
  console.log(`v2-proxy listening on ${base}  (opencode v2 API)`);
  if (lanIp) console.log(`  LAN:        http://${lanIp}:${PROXY_PORT}`);
  console.log("");
  console.log("  Endpoints:");
  console.log(`    OpenAI     ${base}/v1/chat/completions`);
  console.log(`               ${base}/v1/models`);
  console.log(`    Anthropic  ${base}/anthropic/v1/messages`);
  console.log(`               ${base}/anthropic/v1/models`);
  console.log(`    Health     ${base}/health`);
  console.log("");
  console.log("  Auth:");
  if (!REQUIRE_API_KEY) {
    console.log("    mode       public (REQUIRE_API_KEY=false)");
    console.log("    API key    任意值即可通过 —— 随便填 / 留空都行 (ZEN 免费层由 opencode 二进制自身登录鉴权)");
  } else {
    console.log("    mode       required (REQUIRE_API_KEY=true)");
    for (const [name, key] of Object.entries(apiKeys)) {
      console.log(`    ${name.padEnd(12)} ${key}`);
    }
  }
  console.log("");
  console.log(`  SHOW_FREE=${SHOW_FREE}`);
  try {
    await startBackend();
    const models = await getModels();
    console.log(`  Models (${models.length}):`, models.join(", "));
  } catch (e) {
    console.error("  Failed to start opencode backend:", (e as Error).message);
    process.exit(1);
  }
  console.log("");
});
