/** 契约里 int32 的上界：整数那几格超了它，服务端不收。 */
export const MAX_INT32 = 2147483647

/**
 * 上下文长度、输出上限这类整数格子：填的原文哪里不对。
 *
 * 空着不算问题（留空表示继承，或者不知道这一格）。返回的是「哪里不对」那半句，
 * 前面那句「是哪一格」由调用方拼 —— 摆在格子下面的时候不用再说一遍字段名。
 *
 * 两个弹窗（自定义模型、主路由模型）照同一处判：分成两份写，迟早一边收了
 * 1.5、另一边收了 -1。
 */
export function intFieldProblem(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || !Number.isInteger(value)) return '要填整数'
  if (value < 0) return '不能是负数'
  if (value > MAX_INT32) return `别超过 ${MAX_INT32}`
  return null
}
