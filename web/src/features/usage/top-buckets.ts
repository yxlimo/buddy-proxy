export const USAGE_TOP_LIMIT = 10

export interface TopBucketsResult<T> {
  shown: T[]
  total: number
}

/**
 * 长尾分桶（按主会话、按子代理）只展示用得最多的前若干条，
 * total 保留完整数量，供面板标注「共 N 条，显示前 10」。
 */
export function topBuckets<T>(
  buckets: T[],
  limit: number = USAGE_TOP_LIMIT
): TopBucketsResult<T> {
  return { shown: buckets.slice(0, limit), total: buckets.length }
}
