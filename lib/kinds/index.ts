// lib/kinds/index.ts — the kinds, one entry each.
//
// This is where "what does a MiniMax Code gateway look like" lives. The
// registry (lib/provider-kinds.ts) holds the shape; this directory fills it in.
//
// A kind is not an account: two accounts of the MiniMax open platform are two
// providers of the same kind, under one upstream. Everything here takes the
// upstream, so the answer can depend on which one is asking.
//
// Importing a platform module is what registers it, and the order below is the
// order of the registry.

// 这两个种类在自己的模块里登记：接一个开放平台是写一段声明，不是在这里
// 再加一个 registerKind 块。放在这里 import 是为了让登记在 kindOf() 之前发生。
import "../sensenova/register.ts";
import "../intern-ai/register.ts";
import "../qiniu/register.ts";
import "../xinghuo/register.ts";
import "./minimax.ts";
import "./qoder.ts";
import "./workbuddy.ts";
import "./tokenrhythm.ts";
import "./zcode.ts";

export { tokenPlanView } from "./shared.ts";
