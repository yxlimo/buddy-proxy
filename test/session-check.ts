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
//             x-pi-session-id               扩展写的子会话 id
//             x-parent-session-id           中性拼法，两边共用
//             x-agent-name                  中性，两边共用
//
// pi 自己没有父会话的概念：它的子代理跑在服务端，头上分不出来 —— 靠扩展
// 补上。

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
console.log("pi 的子代理（扩展写的头）");

// pi-subagents 把 x-session-affinity 改写成父会话的 id（为了命中父会话的
// 提示缓存），所以子会话 id 必须从 x-pi-session-id 取。
const piSub = lower({
  "user-agent": "pi/1.4.0",
  "x-session-affinity": "ses_parent",
  "x-pi-session-id": "ses_child",
  "x-parent-session-id": "ses_parent",
  "x-agent-name": "be-match",
});
check("子会话 id 认 x-pi-session-id", detectSession(piSub).sessionId === "ses_child", detectSession(piSub).sessionId);
check("父会话认 x-parent-session-id", detectSession(piSub).parentSessionId === "ses_parent", detectSession(piSub).parentSessionId);
check("agent 名认 x-agent-name", detectSession(piSub).agentName === "be-match", detectSession(piSub).agentName);
check(
  "x-pi-session-id 会跟着转发",
  clientSessionHeaders(piSub)["x-pi-session-id"] === "ses_child",
  JSON.stringify(clientSessionHeaders(piSub)),
);

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
console.log("写会话：登录要能覆盖，刷新里的旧代次不能覆盖");

{
  const { writeSession, readSession } = await import("../lib/session.ts");
  const id = "session:provider:test-write";

  // 一次登录的成果（第 1 代）。
  writeSession(id, { accessToken: "a1", refreshToken: "r1", generation: 1, loginAtMs: 1000 });
  check("写进去了", readSession<any>(id)?.generation === 1, String(readSession<any>(id)?.generation));

  // 同一次登录里刷新了一次：第 2 代，比第 1 代新。
  writeSession(id, { accessToken: "a2", refreshToken: "r2", generation: 2, loginAtMs: 1000 });
  check("同一次登录的下一代写进去了", readSession<any>(id)?.generation === 2, String(readSession<any>(id)?.generation));

  // 并发的另一个刷新：第 1 代（更旧），不该覆盖第 2 代。
  writeSession(id, { accessToken: "a3", refreshToken: "r3", generation: 1, loginAtMs: 1000 });
  check("旧代次没有覆盖新的", readSession<any>(id)?.generation === 2, String(readSession<any>(id)?.generation));

  // 重新登录：登录时刻更晚，哪怕代次又从 1 开始，也要写进去。
  writeSession(id, { accessToken: "a4", refreshToken: "r4", generation: 1, loginAtMs: 2000 });
  check("重新登录写进去了", readSession<any>(id)?.generation === 1 && readSession<any>(id)?.accessToken === "a4",
    JSON.stringify(readSession<any>(id)));
}

console.log("");
console.log("结果");
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
