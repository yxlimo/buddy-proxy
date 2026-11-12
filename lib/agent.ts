// lib/agent.ts — 谁发来的请求。
//
// 面板的用量记录里要能看出这是哪个 agent 打的（pi、opencode、dsh……），
// 所以从请求头里认。
//
// 认得出来的：
//
//   pi        user-agent: pi/1.4.0 (linux; node/v24.21.0; x64)
//   opencode  user-agent: opencode/latest/2.1.3/cli
//             x-opencode-client: cli
//
// 认不出来的就报头里的第一个词（curl、node、Mozilla……），再认不出来就是
// unknown。总比空着强。

/** 请求头。键名小写。 */
export type HeaderBag = Record<string, string | string[] | undefined>;

/** 认出来的 agent。 */
export interface AgentInfo {
  /** 归一后的名字：pi、opencode、dsh…… */
  name: string;
  /** 头里带的版本（认得出来才有）。 */
  version: string;
  /** 原始的 user-agent。 */
  userAgent: string;
}

/** 取一个头（大小写不敏感）。 */
function header(headers: HeaderBag, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return String(value[0] ?? "");
    if (value === undefined) return "";
    return String(value);
  }
  return "";
}

/**
 * 从 user-agent 里抠出版本。
 *
 * 找第一个像版本号的那段：pi/1.4.0 (…) → 1.4.0；
 * opencode/latest/2.1.3/cli → 2.1.3（latest 不是版本）。
 */
function versionOf(ua: string): string {
  const m = /(?:^|[/\s])(\d[\w.+-]*)/.exec(ua);
  return m ? m[1] : "";
}

/** 认一个 agent。 */
export function detectAgent(headers: HeaderBag): AgentInfo {
  const ua = header(headers, "user-agent");
  const opencodeClient = header(headers, "x-opencode-client");

  // opencode 自己带这个头，认它最准（它的 user-agent 里还带版本和形态）。
  if (opencodeClient) {
    const version = versionOf(ua);
    return { name: "opencode", version, userAgent: ua };
  }
  if (/^pi\//i.test(ua)) {
    return { name: "pi", version: versionOf(ua), userAgent: ua };
  }
  if (/opencode/i.test(ua)) {
    return { name: "opencode", version: versionOf(ua), userAgent: ua };
  }
  if (/\bdsh\b|harness/i.test(ua)) {
    return { name: "dsh", version: versionOf(ua), userAgent: ua };
  }
  if (/^curl\//i.test(ua)) {
    return { name: "curl", version: versionOf(ua), userAgent: ua };
  }
  if (!ua) {
    return { name: "unknown", version: "", userAgent: "" };
  }
  // 认不出来：报头里的第一个词，别把整个 user-agent 塞进一列。
  const first = ua.split(/[\s/]/)[0] || "unknown";
  return { name: first.slice(0, 24), version: versionOf(ua), userAgent: ua };
}

/** 一次请求属于哪个会话。 */
export interface SessionInfo {
  /** 会话 id。认不出来就是空的。 */
  sessionId: string;
  /** 父会话 id。只有 opencode 的子代理有。 */
  parentSessionId: string;
  /**
   * 子代理的 agent 名（be-match、reviewer……）。
   *
   * 子代理的会话 id 每次运行都不同（`defaultContext: fresh` 的子代理每次
   * 都是全新会话），所以 agent 名才是跨运行能聚合的那一维。
   */
  agentName: string;
}

/**
 * 从头里认出会话。
 *
 * 头名按"谁写的"分：
 *
 *   x-opencode-session-id         opencode 自己的会话
 *   x-opencode-parent-session-id  opencode 的父会话（子代理才有）
 *   x-pi-session-id               pi 扩展写的子会话 id（在 pi 自己的命名空间里，
 *                                 不占用 opencode 的）
 *   x-parent-session-id           父会话，中性拼法：opencode 原生也用这个，
 *                                 语义相同，两边共用
 *   x-agent-name                  agent 名，中性，两边共用
 *   x-session-affinity / x-session-id   pi 自己的会话头
 *
 * 顺序有讲究：pi 的子代理上，pi-subagents 会把 `x-session-affinity` 改写成
 * **父**会话的 id（为了让请求继续命中父会话的提示缓存），所以子会话 id 必须
 * 先从 `x-pi-session-id` 取，否则子代理的会话会被记成父会话。
 */
export function detectSession(headers: HeaderBag): SessionInfo {
  const sessionId =
    header(headers, "x-opencode-session-id") ||
    header(headers, "x-pi-session-id") ||
    header(headers, "x-session-id") ||
    header(headers, "x-session-affinity") ||
    "";
  const parentSessionId =
    header(headers, "x-parent-session-id") || header(headers, "x-opencode-parent-session-id") || "";
  // agent 名是子代理那侧给的（pi 的会话头扩展写这个头）。
  const agentName = header(headers, "x-agent-name") || "";
  return {
    sessionId: sessionId.slice(0, 128),
    parentSessionId: parentSessionId.slice(0, 128),
    agentName: agentName.slice(0, 64),
  };
}

/**
 * 开放 API 平台能看到的客户端头：原样转发，只摘掉网关自己的那几个。
 *
 * 模拟客户端的那几条上游（Qoder、WorkBuddy、MiniMax Code、ZCode）不走这里
 * —— 它们按客户端的样子重建请求，头是挑出来逐个写死的。开放 API 平台（MiniMax
 * 开放平台、TokenRhythm、SenseNova、书生·端砚）是原样转发的，所以这里用反向
 * 名单：正向列举每多出一个上游认的拼法就得回来补一次，漏一次的表现是上游回
 * 「你没带这个头」，而客户端明明带了 —— opencode 的 Zen 缺 `x-opencode-session`
 * 就回 400 MissingSessionID，网关当时枚举了五种拼法，就是不认识这一个。
 *
 * 摘掉的都是网关自己的：
 *
 *   authorization、x-api-key   网关要换成账号自己的 key；x-api-key 是 Anthropic
 *                              方言的客户端用来带网关 key 的，转发出去就等于把
 *                              网关的凭据送给上游
 *   host、content-length       请求是网关重发的，这两个得对得上网关发出去的那条
 *   cookie                     客户端给网关的，不是给上游的
 *   accept-encoding            压缩方式由传输层自己定
 *   connection、keep-alive、proxy-authorization、proxy-authenticate、te、
 *   trailer、transfer-encoding、upgrade
 *                              逐跳头，只管一条连接，不能跟着跨这一跳
 */
const GATEWAY_OWN_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "cookie",
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 头值的上限：够放 user-agent 与各种 trace id，又不给日志和上游送大块数据。 */
const MAX_HEADER_VALUE = 200;

export function clientForwardHeaders(headers: HeaderBag): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (GATEWAY_OWN_HEADERS.has(key)) continue;
    const text = Array.isArray(value) ? value.join(", ") : value;
    if (!text) continue;
    out[key] = text.slice(0, MAX_HEADER_VALUE);
  }
  return out;
}
