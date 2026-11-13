import type { Json } from "../json.ts";
import { randomUUID } from "node:crypto";



/* ------------------------------------------------------------------ *
 * Request conversion
 * ------------------------------------------------------------------ */

/** Anthropic system prompt (string or block list) → OpenAI system message. */
function anthropicSystemToOpenAI(system: unknown): Json | null {
  if (typeof system === "string" && system.trim()) return { role: "system", content: system };
  if (Array.isArray(system)) {
    const text = system
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n");
    if (text.trim()) return { role: "system", content: text };
  }
  return null;
}

/** Anthropic content block → OpenAI content part. */
function anthropicBlockToOpenAIPart(block: Json): Json | null {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image" && block.source) {
    const src = block.source;
    if (src.type === "base64" && src.data) {
      return { type: "image_url", image_url: { url: `data:${src.media_type ?? "image/png"};base64,${src.data}` } };
    }
    if (src.type === "url" && src.url) {
      return { type: "image_url", image_url: { url: src.url } };
    }
  }
  return null;
}

/** Anthropic → OpenAI chat/completions request. */
export function anthropicToOpenAI(body: Json): Json {
  const out: Json = {};
  if (body.model) out.model = body.model;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;

  const messages: Json[] = [];
  const system = anthropicSystemToOpenAI(body.system);
  if (system) messages.push(system);

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role === "assistant" ? "assistant" : "user";
    const content = msg?.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts: Json[] = [];
    const toolCalls: Json[] = [];
    const toolResults: Json[] = [];

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id ?? `call_${randomUUID().slice(0, 12)}`,
          type: "function",
          function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "",
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
        });
      } else {
        const part = anthropicBlockToOpenAIPart(block);
        if (part) parts.push(part);
      }
    }

    if (toolResults.length) {
      // Tool results are their own OpenAI messages, and they must come before the
      // assistant turn they answer.
      messages.push(...toolResults);
    }
    if (toolCalls.length) {
      messages.push({ role: "assistant", content: parts.length ? parts : null, tool_calls: toolCalls });
    } else if (parts.length) {
      messages.push({ role, content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    }
  }
  out.messages = messages;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: Json) => ({
      type: "function",
      function: {
        name: t?.name ?? "",
        description: t?.description ?? "",
        parameters: t?.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "none") out.tool_choice = "none";
  }
  // Thinking is spelled out by one place for both directions (thinkingFields), so
  // "off" and "a level" cannot drift apart between the two conversions
  Object.assign(out, thinkingFields(body, "openai"));
  if (typeof body.stream === "boolean") out.stream = body.stream;
  return out;
}

/**
 * What a request says about thinking: switched off, or a level.
 *
 * `undefined` is not "off": a request with no opinion must reach the upstream
 * with no thinking fields at all, so the upstream's own default is what runs.
 * That is the behaviour every client that never mentions thinking already has,
 * and it must not change.
 */
export type ThinkingIntent = { off: true } | { off: false; effort: string };

/**
 * The names a client writes when it means "no thinking".
 *
 * `off` is pi's tier name and the one opencode's variants will use; `disabled`
 * is what an Anthropic-shaped body says; `none` is the OpenAI effort level that
 * means the absence of thinking. They are three spellings of one intent, and the
 * gateway has to read all three because it does not choose which client calls
 * it — only where the request goes next.
 */
const OFF_SPELLINGS = ["off", "disabled", "none"];

/** Whether any of the spellings says "no thinking". */
function asksToTurnThinkingOff(body: Json): boolean {
  if (body.thinking?.type === "disabled") return true;
  // The tier name may arrive in any of the three slots a level goes in: an agent
  // that learned the name from one client library writes it into another's
  // field, so all three are read. `output_config.effort` is the Anthropic
  // spelling opencode and pi use, `effort` is explicit, `reasoning_effort` is
  // OpenAI's.
  return [body.output_config?.effort, body.effort, body.reasoning_effort].some(
    (value) => typeof value === "string" && OFF_SPELLINGS.includes(value.trim().toLowerCase()),
  );
}

/**
 * Read the thinking intent out of a request, whichever dialect spelled it.
 *
 * "Off" is read first and wins over a level: a body that carries both (an
 * Anthropic `thinking.type=disabled` next to an `output_config.effort`) is
 * contradictory, and the caller who switched thinking off is the cheaper one to
 * be wrong about — honouring the level instead would bill them for thinking
 * they said they did not want.
 */
export function thinkingIntentOf(body: Json): ThinkingIntent | undefined {
  if (asksToTurnThinkingOff(body)) return { off: true };
  const effort = effortOf(body);
  return effort ? { off: false, effort } : undefined;
}

/**
 * The thinking fields to send upstream for one target dialect.
 *
 * Both spellings go out on the OpenAI side — `reasoning_effort` and `thinking`:
 * an upstream reads fields by name and the gateway does not know which name it
 * reads, so both are sent. That duplicate is deliberate and it is the whole
 * point of this function: `reasoning_effort: "none"` alone is what an
 * OpenAI-native upstream (xinghuo's spark) needs to stop thinking, while
 * `thinking: {type: "disabled"}` is what an Anthropic-shaped body says. The
 * cost is that a strictly validating server would reject the field it does not
 * know about — the upstream's own body is in the log when that happens, so it is
 * diagnosable rather than mysterious.
 *
 * The Anthropic side gets only its own spelling: it has no `none` effort level,
 * and sending one is a rejection rather than a hint.
 */
export function thinkingFields(body: Json, dialect: "openai" | "anthropic"): Json {
  const intent = thinkingIntentOf(body);
  if (!intent) return {};
  if (dialect === "anthropic") {
    if (intent.off) return { thinking: { type: "disabled" } };
    return { thinking: { type: "enabled", budget_tokens: budgetFromEffort(intent.effort) } };
  }
  return {
    reasoning_effort: intent.off ? "none" : intent.effort,
    thinking: { type: intent.off ? "disabled" : "enabled" },
  };
}

/**
 * The thinking level a request asks for.
 *
 * Several spellings reach the proxy, depending on the agent and the dialect:
 *   `output_config.effort`  — the Anthropic spelling opencode and pi use
 *   `effort`                — explicit
 *   `reasoning_effort`      — the OpenAI spelling
 *   `thinking.budget_tokens` — a budget instead of a level
 *
 * The level comes first: a budget cannot say which level it meant (two levels
 * share a budget), so a request that carries the level keeps it — that is the
 * only way the top level survives the Anthropic dialect.
 *
 * The off spellings (`off` / `disabled` / `none`) are not levels this returns:
 * they say "no thinking at all", which is an intent rather than a depth, and
 * `thinkingIntentOf` answers that before a level is ever asked for. Returning
 * them as if they were a depth would put `off` into a tier table that has no
 * such tier.
 */
export function effortOf(body: Json): string | undefined {
  if (asksToTurnThinkingOff(body)) return undefined;
  for (const value of [body.output_config?.effort, body.effort, body.reasoning_effort]) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  const budget = body.thinking?.budget_tokens ?? body.thinking_budget_tokens ?? body.thinking_budget;
  if (typeof budget === "number" && budget > 0) return effortFromBudget(budget);
  return undefined;
}

/** Anthropic thinking budget → OpenAI reasoning effort. */
export function effortFromBudget(budget: unknown): string {
  const n = typeof budget === "number" ? budget : 0;
  // The budgets clients actually use: 1024 (minimal), 2048 (low), 8192
  // (medium), 16384 (high). Anything above that is the top level.
  if (n <= 2048) return "low";
  if (n <= 8192) return "medium";
  if (n <= 16384) return "high";
  return "max";
}

/** OpenAI reasoning effort → Anthropic thinking budget. */
export function budgetFromEffort(effort: unknown): number {
  switch (effort) {
    case "minimal":
    case "low":
      return 2048;
    case "high":
      return 16384;
    case "max":
      return 32768;
    case "medium":
      return 8192;
    default:
      return 8192;
  }
}

/**
 * OpenAI → Anthropic messages request.
 *
 * The Anthropic dialect insists on a limit, so one has to be there; the
 * caller says which number to use when the agent did not name one.
 */
export function openaiToAnthropic(body: Json, defaultMaxTokens: number): Json {
  const out: Json = {};
  if (body.model) out.model = body.model;
  out.max_tokens =
    typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : defaultMaxTokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.stop === "string") out.stop_sequences = [body.stop];
  else if (Array.isArray(body.stop) && body.stop.length) out.stop_sequences = body.stop;

  const systemParts: string[] = [];
  const messages: Json[] = [];

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role;

    if (role === "system" || role === "developer") {
      const text = openAIContentToText(msg?.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "tool" || role === "function") {
      // A tool result is a user turn in Anthropic, carrying a tool_result block.
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg?.tool_call_id ?? "",
            content: openAIContentToText(msg?.content),
          },
        ],
      });
      continue;
    }

    const blocks: Json[] = [];
    const contentText = openAIContentToText(msg?.content);
    if (contentText) blocks.push({ type: "text", text: contentText });
    for (const part of Array.isArray(msg?.content) ? msg.content : []) {
      if (part?.type === "image_url" && part.image_url?.url) {
        const url = String(part.image_url.url);
        const m = /^data:([^;]+);base64,(.*)$/.exec(url);
        blocks.push(
          m
            ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }
            : { type: "image", source: { type: "url", url } },
        );
      }
    }
    for (const call of Array.isArray(msg?.tool_calls) ? msg.tool_calls : []) {
      let input: unknown = {};
      try {
        input = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        input = {};
      }
      blocks.push({
        type: "tool_use",
        id: call?.id ?? `toolu_${randomUUID().slice(0, 12)}`,
        name: call?.function?.name ?? "",
        input,
      });
    }

    if (blocks.length) {
      messages.push({ role: role === "assistant" ? "assistant" : "user", content: blocks });
    }
  }

  if (systemParts.length) out.system = systemParts.join("\n\n");
  out.messages = messages;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: Json) => ({
      name: t?.function?.name ?? t?.name ?? "",
      description: t?.function?.description ?? t?.description ?? "",
      input_schema: t?.function?.parameters ?? t?.input_schema ?? { type: "object", properties: {} },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === "auto") out.tool_choice = { type: "auto" };
    else if (tc === "required") out.tool_choice = { type: "any" };
    else if (tc === "none") out.tool_choice = { type: "none" };
    else if (tc?.type === "function" && tc.function?.name) {
      out.tool_choice = { type: "tool", name: tc.function.name };
    }
  }
  Object.assign(out, thinkingFields(body, "anthropic"));
  if (typeof body.stream === "boolean") out.stream = body.stream;
  return out;
}

/** Flatten OpenAI content (string or parts) into text. */
function openAIContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

