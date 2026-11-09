// lib/router/availability.ts — 转发层要的那一份「平台能不能接请求」。
//
// 判定住在 admin 层（lib/admin/platform-state.ts）：路由、目录、面板与健康检查
// 问的是同一件事，必须是同一个答案，所以只有一份判定。
//
// 这里只做转发：导入路径照旧，路由那边的调用点不用改。
//
// 一轮判定里那几张表各读一遍：provider 表、冷却表、已发布模型表（目录要用
// declaredModels）。算几个平台都是同一批表，所以 platformAvailabilities 一次
// 算完 —— 别一个平台算一次，那会把同一批表读好几遍。
//
// 不做缓存：面板改了账号、凭据或者冷却之后，路由必须立刻按新值走 —— 缓存会
// 让路由按旧值走，而面板说已经改好了。读一遍表比按旧值路由便宜。

export {
  declaredModels,
  platformAvailability,
  platformAvailabilities,
  type PlatformAvailability,
  type PlatformState,
} from "../admin/platform-state.ts";
