// lib/minimax/models.ts — the MiniMax Code model catalog, in Anthropic
// GET /v1/models shape.
//
// The LLM gateway has no /models route (`direct_route_not_configured`), so the
// model list comes from the client's own config snapshot. Values below mirror
// the current whitelist in the desktop App's config.yaml; extra metadata
// (reasoning / context / output) is kept because pi reads it from the proxy's
// /v1/models. Unknown model ids are not rejected by the gateway — they fall
// back to MiniMax-M3, so this list is what clients see, not what the server
// validates.
//
// Limits follow the desktop App's own config: context 1M (the App runs
// defaultModelContextWindow: 1000000, and 1M is the top entry of
// contextWindowOptions [512000, 1000000]) and output 128k (limit.output).
// models.dev instead reports 1M context / 512k output; we deliberately take the
// client's lower output figure so clients never plan a response the gateway
// would have to cut. The gateway validates neither number up front (a request
// with max_tokens 512001 still returns 200), so these are advisory values for
// client-side budgeting.

export interface MiniMaxModel {
  id: string;
  display_name: string;
  reasoning: boolean;
  tool_call: boolean;
  temperature: boolean;
  context: number;
  output: number;
  /** Effort levels the gateway accepts for this model ("default" = no thinking). */
  effortOptions: string[];
}

export const MINIMAX_MODELS: MiniMaxModel[] = [
  {
    id: "MiniMax-M3.1-Flash",
    display_name: "MiniMax-M3.1-Flash",
    reasoning: true,
    tool_call: true,
    temperature: true,
    context: 1000000,
    output: 128000,
    effortOptions: ["default", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "MiniMax-M3",
    display_name: "MiniMax-M3",
    reasoning: true,
    tool_call: true,
    temperature: true,
    context: 1000000,
    output: 128000,
    effortOptions: ["default", "low", "medium", "high", "xhigh", "max"],
  },
];

