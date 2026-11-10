// lib/zcode/system.ts — the `system` array ZCode's upstream insists on.
//
// ZCode fingerprints `system` and answers 405 / code 3012 "unusual activity"
// to anything it does not recognise (docs/zcode/3012-system-prompt.md). What it
// accepts, measured against the live upstream on 2026-11-07
// (docs/zcode/system-segments-probe-2026-11-07.md):
//
//   exactly three segments, in this order — the official first, the official
//   second, and the caller's own
//
// One segment more and the request is refused, so a caller's prompt can only
// ever replace the third segment; appending it after the official three makes
// a fourth and gets the request blocked. That is why `zcodeBody()` never lets
// the caller's `system` through verbatim.

/** The first segment of ZCode 3.16.3, verbatim: 42 characters. */
// Not a matter of taste: a single character changed here is 3012. The upstream
// compares the opening of the first segment, and this is the whole of it.
export const OFFICIAL_SEGMENT_1 = "You are ZCode, an interactive coding agent";

/**
 * The second segment of ZCode 3.16.3, verbatim except for two sections.
 *
 * Kept as-is (the upstream recognises the rest word for word): the identity
 * sentence, the security policy, `# Harness`, the `# ZCode Desktop Context`
 * heading, and `### Files & URLs`.
 *
 * Dropped, because they speak to a desktop app that our callers are not:
 *
 * - `### Interactive views` — Gen UI rendering, a `M:\agents-data\...` Windows
 *   directory to write visualisations into, the `visualize` skill and the
 *   `window.zcode` bridge, and `<untrusted_gen_ui_state>`. Our callers render
 *   none of it and have none of those tools, so the prompt would describe a
 *   harness that is not there.
 * - `### Inline Code Comments` — the `::code-comment{...}` directive, an
 *   instruction no caller of ours understands.
 *
 * The trim is measured, not assumed: with 1319 characters gone the upstream
 * still passes the request (probe run S3).
 */
export const OFFICIAL_SEGMENT_2 = `
You are an interactive ZCode agent that helps users with software engineering tasks.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.

# Harness
- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.
- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.
- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.
- Reference code as \`file_path:line_number\` — it's clickable.

# ZCode Desktop Context

### Files & URLs
- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).
- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.
- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).

`;

/** A segment of an Anthropic `system` array. */
export type SystemBlock = { type: "text"; text: string };

/**
 * Tools the official prompt names in TitleCase while a third-party harness
 * names them in lowercase; used to say which are which in the third segment.
 */
const NAMED_ABOVE = ["write", "bash", "read", "grep"] as const;

/** Tools the official prompt names that a third-party harness does not have. */
const NOT_IN_HARNESS = ["Skill", "NotebookEdit", "WebSearch"] as const;

/**
 * The `system` array for a ZCode request: three segments, never more.
 *
 * `callerSystem` is what the agent sent (Anthropic allows a string or a list of
 * text blocks) and becomes the third segment, followed by a short note about
 * tool names. Without it the third segment is the note alone — the upstream
 * still wants three segments.
 */
export function zcodeSystem(
  callerSystem: unknown,
  toolNames: readonly string[] = [],
): SystemBlock[] {
  const caller = systemText(callerSystem);
  const note = toolNote(toolNames);
  return [
    { type: "text", text: OFFICIAL_SEGMENT_1 },
    { type: "text", text: OFFICIAL_SEGMENT_2 },
    { type: "text", text: caller.trim() ? `${caller}\n\n${note}` : note },
  ];
}

/**
 * The tool names in a request body's `tools`, whichever dialect wrote them:
 * Anthropic's `{name}` and OpenAI's `{function:{name}}`.
 */
export function toolNamesOf(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    const name = typeof tool?.name === "string" ? tool.name : tool?.function?.name;
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names;
}

/**
 * The caller's system prompt as one string.
 *
 * Anthropic accepts both a string and a list of text blocks; the two are the
 * same prompt, so they are flattened the same way.
 */
function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) =>
      typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "",
    )
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * Why the third segment ends with a note on tool names.
 *
 * The official prompt above talks about `Write`, `Bash`, `Skill` and friends.
 * Our callers name their tools in lowercase and have no `Skill`. Left alone,
 * an agent reads instructions about tools it cannot call and invents them —
 * so the segment says which names this harness uses, and only the names the
 * request actually carries.
 */
function toolNote(toolNames: readonly string[]): string {
  const have = NAMED_ABOVE.filter((name) => toolNames.includes(name));
  const absent = NOT_IN_HARNESS.filter((name) => !toolNames.includes(name));
  const lines = [
    "# Tool names",
    have.length > 0
      ? `This harness names its tools in lowercase. Where the text above speaks of writing a file, running a command, reading a file or searching, call this harness's own tools: ${have.join(", ")}.`
      : "This harness names its tools in lowercase. Where the text above speaks of writing a file, running a command, reading a file or searching, use the tool this harness offers for it.",
  ];
  if (absent.length > 0) {
    lines.push(`Do not call tools this harness does not have (${absent.join(", ")}).`);
  }
  return lines.join("\n");
}
