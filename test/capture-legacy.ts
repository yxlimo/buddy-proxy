// test/capture-legacy.ts — record the China region's answer.
//
// The legacy (COSY) protocol cannot go through the recording proxy: the
// gateway closes the connection when the request comes from another host. So
// the call is made here, signed the same way the router signs it, and the
// answer is written down directly.
//
//   node --experimental-strip-types test/capture-legacy.ts [model-key]

import { legacyChatCompletion } from "../lib/qoder-legacy.ts";
import { fixtureName, writeFixture } from "./fixture-name.ts";

const modelKey = process.argv[2] ?? "gmodel";
const region = "cn" as const;

/** The path the router asks for, so the mock finds the fixture. */
const ROUTE =
  "/qoder-cn/algo/api/v2/service/pro/sse/agent_chat_generation" +
  "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

console.log(`asking the China region for ${modelKey} — it thinks for a while...`);
const started = Date.now();
const r = await legacyChatCompletion(
  {
    messages: [{ role: "user", content: "say ok" }],
    modelKey,
    displayName: "GLM-5.3",
    maxTokens: 32,
    reasoning: true,
    contextWindow: 1000000,
  },
  { region },
);
const body = await r.text();
const headers: Record<string, string> = {};
r.headers.forEach((value, key) => {
  headers[key] = value;
});

const name = fixtureName("POST", ROUTE, "all");
writeFixture(name, {
  upstream: `https://gateway.qoder.com.cn${ROUTE}`,
  status: r.status,
  headers,
  body,
});
console.log(`recorded ${name} (${r.status}, ${body.length} bytes, ${Math.round((Date.now() - started) / 1000)}s)`);
