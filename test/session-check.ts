// test/session-check.ts — 认出请求属于哪个会话、是不是子代理。
//
//   node --experimental-strip-types test/session-check.ts
//
// 各客户端发的头不一样：
//
//   opencode  x-opencode-session-id
//             x-opencode-parent-session-id   子代理才有
//             x-session-affinity / X-Session-Id
//   pi        x-session-id                  要开 compat.sendSessionAffinityHeaders
//
// pi 没有父会话的概念：它的子代理跑在服务端，头上分不出来。

import { detectSession, clientSessionHeaders } from "../lib/agent.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const lower = (h: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
};

console.log("opencode");

const oc = lower({
  "x-opencode-client": "cli",
  "x-opencode-session-id": "ses_abc123",
  "x-opencode-parent-session-id": "ses_parent",
});
check("认出会话", detectSession(oc).sessionId === "ses_abc123", detectSession(oc).sessionId);
check("认出父会话", detectSession(oc).parentSessionId === "ses_parent", detectSession(oc).parentSessionId);

console.log("");
console.log("子代理的 agent 名");

const sub = lower({
  "x-opencode-session-id": "ses_child",
  "x-opencode-parent-session-id": "ses_parent",
  "x-agent-name": "be-match",
});
check("认出 agent 名", detectSession(sub).agentName === "be-match", detectSession(sub).agentName);
check("子会话 id 优先于别的拼法", detectSession(sub).sessionId === "ses_child");
check("没有 agent 名就是空的", detectSession(oc).agentName === "");

const ocMain = lower({
  "x-opencode-client": "cli",
  "x-opencode-session-id": "ses_main",
});
check(
  "主代理没有父会话",
  detectSession(ocMain).parentSessionId === "",
  detectSession(ocMain).parentSessionId,
);

console.log("");
console.log("pi");

const pi = lower({ "x-session-id": "pi-session-1" });
check("认出会话", detectSession(pi).sessionId === "pi-session-1", detectSession(pi).sessionId);
check("没有父会话", detectSession(pi).parentSessionId === "");

const affinity = lower({ "x-session-affinity": "aff-1" });
check("另一套拼法也认", detectSession(affinity).sessionId === "aff-1", detectSession(affinity).sessionId);

console.log("");
console.log("认不出来");

const none = lower({ "user-agent": "curl/8" });
check("没有会话头就是空", detectSession(none).sessionId === "");
check("没有会话头就没有父会话", detectSession(none).parentSessionId === "");

console.log("");
console.log("转给开放平台的头");

const forwarded = clientSessionHeaders(oc);
const withAgent = clientSessionHeaders(sub);
check(
  "agent 名跟着走",
  withAgent["x-agent-name"] === "be-match",
  JSON.stringify(withAgent),
);
check(
  "会话头跟着走",
  forwarded["x-opencode-session-id"] === "ses_abc123" &&
    forwarded["x-opencode-parent-session-id"] === "ses_parent",
  JSON.stringify(forwarded),
);
const noAuth = clientSessionHeaders(
  lower({ authorization: "Bearer secret", "x-session-id": "s1", host: "example.com" }),
);
check("不带走 authorization", !("authorization" in noAuth), JSON.stringify(noAuth));
check("不带走 host", !("host" in noAuth), JSON.stringify(noAuth));
check("带走了会话头", noAuth["x-session-id"] === "s1", JSON.stringify(noAuth));

console.log("");
console.log("结果");
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
