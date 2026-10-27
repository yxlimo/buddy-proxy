// lib/router/upstreams/index.ts — the upstream adapters, one per kind.
//
// Each upstream has its own protocol and its own idea of what a model is
// called, but the way an answer is written back to the client is the same for
// all of them (see deliver.ts). So an adapter only has to do its own part:
// turn the request into what the upstream wants, call it, and hand the answer
// over.

export * from "./policy.ts";
export * from "./minimax.ts";
export * from "./workbuddy.ts";
export * from "./qoder.ts";
export * from "./zcode.ts";
export * from "./tokenrhythm.ts";
export * from "./open-platform.ts";
