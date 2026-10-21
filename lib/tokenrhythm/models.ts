// lib/tokenrhythm/models.ts — the models the relay station serves.
//
// The platform publishes a longer list, but only one of them is offered here:
// the relay is a way to reach a model that the other upstreams do not carry,
// and every model added to it is another name for the same few answers.

export interface TokenRhythmModel {
  /** The model id as the upstream knows it. */
  id: string;
  /** The name the list shows. */
  name: string;
  /** Whether the model can think. */
  reasoning: boolean;
  /** Whether the model can call tools. */
  toolCall: boolean;
  /** The levels the upstream's thinking mode takes. */
  efforts: string[];
  /** The context window, in tokens. */
  context: number;
  /** The output limit, in tokens. */
  maxOutput: number;
}

export const TOKENRHYTHM_MODELS: TokenRhythmModel[] = [
  {
    id: "deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    reasoning: true,
    toolCall: true,
    efforts: ["low", "high", "max"],
    context: 1000000,
    maxOutput: 384000,
  },
];

export const TOKENRHYTHM_MODEL_IDS = new Set(TOKENRHYTHM_MODELS.map((m) => m.id));
