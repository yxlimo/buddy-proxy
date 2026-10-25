// lib/json.ts — 形状没知的 JSON。
//
// 客户端发来的请求体、上游回的答复、事件流里的帧：形状是对方定的，网关只读
// 自己关心的那几个字段，其余原样传过去。所以这里是一个宽松的类型：键是
// 字符串，值是什么都行（读哪个字段都不会报类型错）。
//
// 真正要紧的地方是边界：网关自己读的那几个字段（model、messages、max_tokens…）
// 在读之前都有形状检查或者明确的取值方式，见 lib/dialect/ 与 lib/router/。

/** 一个 JSON 对象。 */
export type Json = { [key: string]: any };
