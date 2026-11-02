// lib/router/availability.ts — 转发层要的那一份「平台能不能接请求」。
//
// 判定住在 admin 层（lib/admin/platform-state.ts）：路由、目录、面板与健康检查
// 问的是同一件事，必须是同一个答案，所以只有一份判定。
//
// 这里只做转发：导入路径照旧，路由那边的调用点不用改。

export {
  declaredModels,
  platformAvailability,
  platformAvailabilities,
  type PlatformAvailability,
  type PlatformState,
} from "../admin/platform-state.ts";
