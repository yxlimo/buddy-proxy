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
 * opencode 自带这些头：
 *   x-opencode-session-id        会话
 *   x-opencode-parent-session-id 父会话（子代理才有）
 *   x-session-affinity / X-Session-Id  会话（另一套拼法）
 *
 * pi 的会话头要开 `compat.sendSessionAffinityHeaders` 才有（x-session-id）。
 * pi 没有父会话的概念 —— 它的子代理跑在服务端，头上分不出来。
 */
export function detectSession(headers: HeaderBag): SessionInfo {
  const sessionId =
    header(headers, "x-opencode-session-id") ||
    header(headers, "x-session-id") ||
    header(headers, "x-session-affinity") ||
    "";
  const parentSessionId =
    header(headers, "x-opencode-parent-session-id") || header(headers, "x-parent-session-id") || "";
  // agent 名是子代理那侧给的（pi 的会话头扩展写这个头）。
  const agentName = header(headers, "x-agent-name") || "";
  return {
    sessionId: sessionId.slice(0, 128),
    parentSessionId: parentSessionId.slice(0, 128),
    agentName: agentName.slice(0, 64),
  };
}

/**
 * 开放 API 平台能看到的客户端头。
 *
 * 模拟客户端的那几条上游（Qoder、WorkBuddy、MiniMax Code、ZCode）是按客户端
 * 的样子重建请求的 —— 只取必要的字段，多余的头直接无视，不转发。
 *
 * 开放 API 平台（MiniMax 开放平台、TokenRhythm、SenseNova、书生·端砚）是
 * 直接转发的，所以会话相关的头可以跟着走：平台自己可能拿它做会话亲和或者
 * 记账。
 *
 * 只带会话这一族：authorization、host、content-length 这些必须是网关自己的。
 */
export function clientSessionHeaders(headers: HeaderBag): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    "x-session-id",
    "x-session-affinity",
    "x-opencode-session-id",
    "x-opencode-parent-session-id",
    "x-parent-session-id",
    "x-agent-name",
  ]) {
    const value = header(headers, name);
    if (value) out[name] = value.slice(0, 200);
  }
  return out;
}
