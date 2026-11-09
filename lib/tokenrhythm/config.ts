// lib/tokenrhythm/config.ts — 中转站的地址。
//
// 单独一个文件，跟别家一样（lib/qiniu/config.ts、lib/xinghuo/config.ts……）：
// 地址是配置，不是账号。
//
// 另有一个理由：lib/tokenrhythm/accounts.ts 与 lib/kinds/tokenrhythm.ts 互相
// 引着（accounts.ts 引 providers，providers 引 platforms，platforms 引 kinds，
// kinds 引 accounts.ts）—— 地址放在这个叶子模块里，两边读的是同一份常量，
// 也不会在模块求值期读一个还在初始化的常量。

import { configString } from "../config.ts";

/** 平台的根：登录、控制台、钱包都在它下面。 */
export const TOKENRHYTHM_API_BASE = configString("TOKENRHYTHM_API_BASE", "https://tokenrhythm.studio").replace(
  /\/+$/,
  "",
);

/** 推理端点的根（平台根 + /v1）。 */
export const TOKENRHYTHM_INFER_BASE = configString("TOKENRHYTHM_INFER_BASE", `${TOKENRHYTHM_API_BASE}/v1`).replace(
  /\/+$/,
  "",
);
