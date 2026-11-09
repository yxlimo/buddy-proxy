/**
 * 开放平台的预填模板。
 *
 * 这些只是填表的起点：面板拿它把 id、名字、地址三格填上。它不参与路由，也不
 * 参与校验 —— 平台建好以后走的是自己那份地址，模板不跟着。有人改了地址或 id
 * 也照样能用：模板是起点，不是白名单。id 撞了就是那个平台已经存在，服务端会
 * 说明，面板照它的话显示。
 *
 * 数据来自两个 MIT 许可的项目（照抄了其中的中转站预设，按域名去重、剔掉了
 * 本地地址与来路不明的条目）：
 *
 *   - farion1231/cc-switch（MIT）：src/config/piProviderPresets.ts、
 *     src/config/openclawProviderPresets.ts
 *   - yetone/magpie（MIT）：internal/provider/presets.go
 *
 * 数据只有一份，就在同目录的 templates.json。改数据直接改那个 JSON 文件，
 * 不用跑任何生成脚本。
 */

import raw from './templates.json'

export type PlatformTemplate = {
  id: string
  label: string
  baseUrl: string
}

/**
 * 面板拿来填表的那张表。
 *
 * 类型写死在这儿：JSON 里少一个字段或写错一个字段，编译就过不去。
 */
export const PLATFORM_TEMPLATES: PlatformTemplate[] = raw
