// lib/credential-ids.ts — 凭据在数据库里的 id。
//
// 每个 provider 的凭据都归它自己 —— 两个同 kind 的账号各有各的会话。
// 这一处是唯一的算法：会话是 session:provider:<id>，多出来的东西
// （一把 key、一个租户）往后接一段。
//
// 放在叶子模块里：zcode/auth.ts 要用它，而 providers.ts 会把各平台都拉
// 进来（那边有模块循环）。从 providers.ts 引，会把一圈东西拖到
// zcode/auth.ts 的加载顺序里 —— 单独 import 它就会因为循环而崩。

export function providerSecretId(providerId: string, suffix = ""): string {
  return suffix ? `key:provider:${providerId}:${suffix}` : `session:provider:${providerId}`;
}
