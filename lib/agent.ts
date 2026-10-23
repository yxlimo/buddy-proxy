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
