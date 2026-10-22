import { createFileRoute } from '@tanstack/react-router'
import { UsagePage } from '@/features/usage'

/**
 * 用量页面的筛选和分页都写在 URL 里：刷新和分享链接都保得住状态。
 */
export const Route = createFileRoute('/_authenticated/usage')({
  validateSearch: (search: Record<string, unknown>) => ({
    page: typeof search.page === 'number' ? search.page : undefined,
    pageSize: typeof search.pageSize === 'number' ? search.pageSize : undefined,
    q: typeof search.q === 'string' ? search.q : undefined,
    // 上游和模型的 id 有可能是纯数字，查询串解析成数字了，这里拉回字符串。
    upstream:
      search.upstream === undefined || search.upstream === null
        ? undefined
        : String(search.upstream),
    model:
      search.model === undefined || search.model === null
        ? undefined
        : String(search.model),
    // 时间窗：hour / day / week / month，空表示全部。
    window:
      search.window === undefined || search.window === null
        ? undefined
        : String(search.window),
  }),
  component: UsagePage,
})
