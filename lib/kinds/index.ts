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

// 登记发生在 import 的时候：接一个平台是写一段声明，不是在这里再加一个
// registerKind 块。
import "./minimax.ts";
import "./qoder.ts";
import "./workbuddy.ts";
import "./zcode.ts";
// 开放平台：用户在面板上加的那些平台（表里的行）都是这一类。放在最后：它排在
// 面板的 kind 列表末尾（下面的顺序就是注册表的顺序）。
import "./openai.ts";
// 上游讲 Anthropic Messages 的那一类开放平台：同样是「用户自己加」的形态，
// 只是报文形状与鉴权头不一样。
import "./anthropic.ts";

export { tokenPlanView } from "./shared.ts";
