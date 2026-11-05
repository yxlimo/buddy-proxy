// lib/platform-templates.ts — 代码里的平台模板。现在一个都没有。
//
// 平台全在表里了（lib/open-platforms.ts 那张 platform 表）：模拟客户端那一族由启动
// 时的播种按目录补齐（lib/platform-catalog.ts 的 SIMULATED_CLIENTS），厂商那几家由
// 平台模板表补，用户自己加的本来就是表里的行。
//
// 这一层只剩类型与一个空名单。名单留着的理由是 import：lib/platforms.ts 还在转出
// 它、还有地方 `import { PLATFORMS }`。清空名单是一件事，删导出是另一件事 —— 后
// 者会把一堆 import 打红，等那些调用方都改完再删。
//
// 这一层是叶子：不引任何模块。按 id 判「是不是模板平台」的那些判别条件因此全部
// 失效（空名单对谁都答不属于）—— 平台之间的区别现在只剩 kind，判别函数在
// lib/platform-catalog.ts（isSimulatedClientKind）。

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
 * 代码里的模板。现在是空的：平台的唯一数据源是表里的行。
 *
 * The region and the name live with the platform rather than with the account:
 * they are properties of the service, not of who is logged in. That is why the
 * table carries them, and why seeding one row per platform is enough.
 */
export const PLATFORMS: Platform[] = [];
