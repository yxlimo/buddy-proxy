import { describe, expect, it, vi, type Mock } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { type NavigateFn, useTableUrlState } from '@/hooks/use-table-url-state'

function lastNavigateOpts(navigate: Mock<NavigateFn>) {
  const calls = navigate.mock.calls
  return calls[calls.length - 1]?.[0]
}

function applyLastSearchFn(
  navigate: Mock<NavigateFn>,
  prev: Record<string, unknown>
) {
  const opts = lastNavigateOpts(navigate)
  if (!opts) return undefined
  const s = opts.search
  if (typeof s === 'function') {
    return s(prev) as Record<string, unknown>
  }
  return s as Record<string, unknown>
}

describe('useTableUrlState', () => {
  it('从 URL 里读出分页', () => {
    const navigate = vi.fn() as Mock<NavigateFn>
    const { result } = renderHook(() =>
      useTableUrlState({
        search: { page: 3, pageSize: 25 },
        navigate,
        pagination: { defaultPage: 1, defaultPageSize: 10 },
      })
    )

    expect(result.current.pagination).toEqual({
      pageIndex: 2,
      pageSize: 25,
    })
  })

  it('URL 里没有就默认值', () => {
    const navigate = vi.fn() as Mock<NavigateFn>
    const { result } = renderHook(() =>
      useTableUrlState({
        search: {},
        navigate,
        pagination: { defaultPage: 1, defaultPageSize: 10 },
      })
    )

    expect(result.current.pagination).toEqual({
      pageIndex: 0,
      pageSize: 10,
    })
  })

  it('翻页时把页码写回 URL，回到默认值就删掉', () => {
    const navigate = vi.fn() as Mock<NavigateFn>
    const prev = { page: 2, pageSize: 20, filter: 'q' }
    const { result } = renderHook(() =>
      useTableUrlState({
        search: prev,
        navigate,
        pagination: { defaultPage: 1, defaultPageSize: 10 },
      })
    )

    act(() => {
      result.current.onPaginationChange({ pageIndex: 0, pageSize: 10 })
    })

    expect(applyLastSearchFn(navigate, prev)).toMatchObject({
      page: undefined,
      pageSize: undefined,
      filter: 'q',
    })
  })

  it('改了筛选就把页码重置回第一页', () => {
    const navigate = vi.fn() as Mock<NavigateFn>
    const prev = { page: 5, upstream: 'minimax' }
    const { result } = renderHook(() =>
      useTableUrlState({
        search: prev,
        navigate,
        pagination: { defaultPage: 1, defaultPageSize: 10 },
        columnFilters: [
          { columnId: 'upstream', searchKey: 'upstream', type: 'string' },
        ],
      })
    )

    act(() => {
      result.current.onColumnFiltersChange([
        { id: 'upstream', value: 'qoder' },
      ])
    })

    expect(applyLastSearchFn(navigate, prev)).toEqual({
      page: undefined,
      upstream: 'qoder',
    })
  })

  it('从 URL 里读出按上游、按模型的筛选', () => {
    const navigate = vi.fn() as Mock<NavigateFn>
    const { result } = renderHook(() =>
      useTableUrlState({
        search: { upstream: 'minimax', model: 'm2' },
        navigate,
        pagination: { defaultPage: 1, defaultPageSize: 10 },
        columnFilters: [
          { columnId: 'upstream', searchKey: 'upstream', type: 'string' },
          { columnId: 'model', searchKey: 'model', type: 'string' },
        ],
      })
    )

    expect(result.current.columnFilters).toEqual([
      { id: 'upstream', value: 'minimax' },
      { id: 'model', value: 'm2' },
    ])
  })

  it('全局搜索写进 URL，清空就把那项删掉', () => {
    const navigate = vi.fn() as Mock<NavigateFn>
    const prev = { page: 2, filter: 'hello' }
    const { result } = renderHook(() =>
      useTableUrlState({
        search: prev,
        navigate,
        pagination: { defaultPage: 1, defaultPageSize: 10 },
        globalFilter: { enabled: true, key: 'filter' },
      })
    )

    expect(result.current.globalFilter).toBe('hello')

    act(() => {
      result.current.onGlobalFilterChange?.('  next  ')
    })

    expect(applyLastSearchFn(navigate, prev)).toEqual({
      page: undefined,
      filter: 'next',
    })

    act(() => {
      result.current.onGlobalFilterChange?.('   ')
    })
    expect(applyLastSearchFn(navigate, prev)).toMatchObject({
      filter: undefined,
    })
  })

  it('页码超出范围就退回第一页', () => {
    const navigate = vi.fn() as Mock<NavigateFn>
    const { result } = renderHook(() =>
      useTableUrlState({
        search: { page: 5 },
        navigate,
        pagination: { defaultPage: 1, defaultPageSize: 10 },
      })
    )

    act(() => {
      result.current.ensurePageInRange(2)
    })

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(lastNavigateOpts(navigate)?.replace).toBe(true)
    expect(applyLastSearchFn(navigate, { page: 5, filter: 'x' })).toMatchObject({
      page: undefined,
      filter: 'x',
    })
  })

  it('URL 变了（浏览器后退）本地筛选跟着变', () => {
    const navigate = vi.fn() as Mock<NavigateFn>
    const { result, rerender } = renderHook(
      ({ search }: { search: Record<string, unknown> }) =>
        useTableUrlState({
          search,
          navigate,
          pagination: { defaultPage: 1, defaultPageSize: 10 },
          columnFilters: [
            { columnId: 'upstream', searchKey: 'upstream', type: 'string' },
          ],
          globalFilter: { enabled: true, key: 'q' },
        }),
      {
        initialProps: {
          search: { upstream: 'minimax', q: 'm2' } as Record<string, unknown>,
        },
      }
    )

    expect(result.current.columnFilters).toEqual([
      { id: 'upstream', value: 'minimax' },
    ])
    expect(result.current.globalFilter).toBe('m2')

    // URL 里的筛选没了（后退），本地状态要跟着没。
    rerender({ search: {} })

    expect(result.current.columnFilters).toEqual([])
    expect(result.current.globalFilter).toBe('')
  })
})
