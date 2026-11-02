// lib/platform-templates.ts — 代码里的平台模板。
//
// 平台有两处数据源：这里的模板（代码里写死的）与表里的开放平台
// （lib/open-platforms.ts）。模板优先：id 撞了算模板的 —— 把模板加回代码时
// 不用先清库，回滚是安全的。
//
// 这一层是叶子：不引任何模块。两边都要认得模板的 id 名单（表里的开放平台
// 不能跟模板重名），所以名单放在这里，谁都能直接引 —— 不用谁在求值期把名单
// 交给别人（那件事出过事：模块求值期的先后顺序一变，判重就失效了）。

/** 一个平台：代码里的模板，或者表里的开放平台。 */
export interface Platform {
  /** 路径里那一段。改它等于打断调用方。 */
  id: string;
  /** 怎么跟它说话 —— 也就是 kind 注册表里的那一类。 */
  kind: string;
  /** 面板上给人看的名字。 */
  label: string;
  /** 区域：cn / global / 空。 */
  region: string;
}

/**
 * 代码里的模板。
 *
 * The region and the name live with the platform rather than with the account:
 * they are properties of the service, not of who is logged in.
 */
export const PLATFORMS: Platform[] = [
  { id: "minimax", kind: "minimax", label: "MiniMax Code", region: "cn" },
  { id: "qoder", kind: "qoder", label: "Qoder（全球区）", region: "global" },
  { id: "qoder-cn", kind: "qoder", label: "Qoder（中国区）", region: "cn" },
  { id: "workbuddy-cn", kind: "workbuddy", label: "WorkBuddy（中国区）", region: "cn" },
  { id: "workbuddy-global", kind: "workbuddy", label: "WorkBuddy（国际区）", region: "global" },
  { id: "tokenrhythm", kind: "tokenrhythm", label: "TokenRhythm", region: "" },
  { id: "sensenova", kind: "sensenova", label: "SenseNova", region: "" },
  { id: "intern-ai", kind: "intern-ai", label: "书生·端砚", region: "" },
  { id: "qiniu", kind: "qiniu", label: "七牛云", region: "" },
  { id: "xinghuo", kind: "xinghuo", label: "讯飞星火", region: "" },
];
