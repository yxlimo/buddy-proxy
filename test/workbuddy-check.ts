// test/workbuddy-check.ts — the parts of the WorkBuddy client that were
// changed to match the official one.
//
//   node --experimental-strip-types test/workbuddy-check.ts
//
// Each check is one behaviour the official client has and the proxy did not.

import { buildChatBody, conversationIdFor } from "../lib/workbuddy/transport.ts";
import { clampEffort } from "../lib/workbuddy/models.ts";
import { uuidv7Hex } from "../lib/ids.ts";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const model = {
  id: "hy3",
  display_name: "Hy3",
  credits: 0,
  context: 1000000,
  maxOutput: 32000,
  vision: false,
  tools: true,
  reasoning: true,
  onlyReasoning: false,
  efforts: ["low", "high", "max"],
  temperature: 0.9,
  topP: 1,
};

const noTools = { ...model, id: "no-tools", tools: false, efforts: [] as string[] };

console.log("");
console.log("the thinking level");

check("a level the model supports is kept", clampEffort("high", ["low", "high", "max"]) === "high");
check("a level above the supported ones steps down", clampEffort("medium", ["low", "high", "max"]) === "low");
check("the level below the asked one is used", clampEffort("xhigh", ["low", "high", "max"]) === "high");
check("a level that is not a level falls back to the smallest", clampEffort("wild", ["low", "high"]) === "low");
check("max becomes high when the model lists no levels", clampEffort("max", []) === "high");
check("xhigh becomes high when the model lists no levels", clampEffort("xhigh", []) === "high");
check("low stays low when the model lists no levels", clampEffort("low", []) === "low");

console.log("");
console.log("the request body");

const body = buildChatBody(
  { model: "hy3", messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium", temperature: 0.1 },
  model,
);
check("the thinking level is clamped", body.reasoning_effort === "low", String(body.reasoning_effort));
check("the caller's temperature is kept", body.temperature === 0.1);
check("the model carries no field the client does not send", !("cache_retention" in body));
check("the stream is asked for", body.stream === true);
check("the usage is asked for", body.stream_options?.include_usage === true);

const withTools = buildChatBody(
  { model: "no-tools", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }] },
  noTools,
);
check("a model without tools is sent no tools", !("tools" in withTools));

const defaults = buildChatBody({ model: "hy3", messages: [{ role: "user", content: "hi" }] }, model);
check("the model's own temperature is sent when the caller has none", defaults.temperature === 0.9);
check("the model's own top_p is sent when the caller has none", defaults.top_p === 1);

console.log("");
console.log("the conversation id");

const messages = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "the first question" },
];
const first = conversationIdFor(messages);
const grown = conversationIdFor([...messages, { role: "assistant", content: "an answer" }, { role: "user", content: "another" }]);
check("the id is the same for the same conversation", first === grown);
check("a different conversation gets a different id", first !== conversationIdFor([{ role: "user", content: "other" }]));
check("the id looks like a uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first), first);
check("a client that brings its own id keeps it", conversationIdFor(messages, "client-id") === "client-id");

console.log("");
console.log("the identifiers");

const hex = uuidv7Hex();
check("the id is 32 hexadecimal characters", /^[0-9a-f]{32}$/.test(hex), hex);
check(
  "the id has the shape the client checks",
  /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(hex),
  hex,
);
check("two ids are not the same", uuidv7Hex() !== hex);

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
