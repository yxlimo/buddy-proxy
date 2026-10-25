import { useEffect, useMemo, useState } from 'react'
import {
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { UsageEvent } from '@/gen/buddy/admin/v1/admin_pb'
import { type NavigateFn, useTableUrlState } from '@/hooks/use-table-url-state'
import {
  DataTableColumnHeader,
  DataTablePagination,
  DataTableToolbar,
} from '@/components/data-table'
import { ErrorState, LoadingState } from '@/components/async-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCompact, formatDateTime, formatMillis } from '@/lib/format'

// Radix 的 Select 不让用空字符串当值，用一个哨兵表示「不筛」。
const ALL = '__all__'

type UsageTableProps = {
  data: UsageEvent[]
  /** 明细还在取。 */
  isPending?: boolean
  /** 明细取失败了。 */
  error?: unknown
  onRetry?: () => void
  search: Record<string, unknown>
  navigate: NavigateFn
  upstreamOptions: { label: string; value: string }[]
  modelOptions: { label: string; value: string }[]
}

/** 会话 id 太长，表格里只显示头尾。 */
function shortSession(id: string | undefined): string {
  if (!id) return '—'
  if (id.length <= 12) return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

export function UsageTable({
  data,
  isPending,
  error,
  onRetry,
  search,
  navigate,
  upstreamOptions,
  modelOptions,
}: UsageTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})

  const {
    columnFilters,
    onColumnFiltersChange,
    pagination,
    onPaginationChange,
    globalFilter,
    onGlobalFilterChange,
    ensurePageInRange,
  } = useTableUrlState({
    search,
    navigate,
    pagination: { defaultPage: 1, defaultPageSize: 20 },
    globalFilter: { enabled: true, key: 'q' },
    columnFilters: [
      { columnId: 'upstream', searchKey: 'upstream', type: 'string' },
      { columnId: 'model', searchKey: 'model', type: 'string' },
    ],
  })

  const columns = useMemo<ColumnDef<UsageEvent>[]>(
    () => [
      {
        id: 'ts',
        accessorKey: 'ts',
        header: '时间',
        cell: ({ row }) => (
          <span className='font-mono text-xs whitespace-nowrap'>
            {formatDateTime(row.original.ts)}
          </span>
        ),
      },
      {
        id: 'upstream',
        accessorKey: 'upstreamId',
        header: 'Provider',
        filterFn: 'equalsString',
        cell: ({ row }) => (
          <span className='text-xs'>{row.original.upstreamId || '—'}</span>
        ),
      },
      {
        id: 'model',
        accessorKey: 'model',
        header: '模型',
        filterFn: 'equalsString',
        cell: ({ row }) => (
          <span className='font-mono text-xs'>{row.original.model || '—'}</span>
        ),
      },
      {
        id: 'agent',
        accessorKey: 'agent',
        header: 'agent',
        cell: ({ row }) => (
          <span className='text-xs'>{row.original.agent || '—'}</span>
        ),
      },
      {
        id: 'session',
        accessorKey: 'sessionId',
        header: '会话',
        cell: ({ row }) => (
          <span className='font-mono text-xs' title={row.original.sessionId}>
            {shortSession(row.original.sessionId)}
          </span>
        ),
      },
      {
        id: 'parentSession',
        accessorKey: 'parentSessionId',
        // The direct parent of that request. The card above rolls the whole
        // chain up into the main session.
        header: '上级会话',
        cell: ({ row }) => (
          <span className='font-mono text-xs' title={row.original.parentSessionId}>
            {row.original.parentSessionId ? shortSession(row.original.parentSessionId) : '主代理'}
          </span>
        ),
      },
      {
        id: 'agentName',
        accessorKey: 'agentName',
        header: 'agent 名',
        cell: ({ row }) => (
          <span className='text-xs'>{row.original.agentName || '—'}</span>
        ),
      },
      {
        id: 'client',
        accessorKey: 'client',
        header: '模拟客户端',
        cell: ({ row }) => (
          <span className='text-xs'>{row.original.client || '—'}</span>
        ),
      },
      {
        id: 'tokens',
        header: 'token（入 / 出）',
        cell: ({ row }) => (
          <span className='font-mono text-xs whitespace-nowrap'>
            {formatCompact(row.original.promptTokens)} /{' '}
            {formatCompact(row.original.completionTokens)}
            {row.original.reasoningTokens > 0n
              ? ` / ${formatCompact(row.original.reasoningTokens)}`
              : ''}
          </span>
        ),
      },
      {
        id: 'latency',
        accessorKey: 'latencyMs',
        header: '耗时',
        cell: ({ row }) => (
          <span className='font-mono text-xs whitespace-nowrap'>
            {formatMillis(row.original.latencyMs)}
          </span>
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: '结果',
        cell: ({ row }) => (
          <div className='grid gap-0.5'>
            <span className='text-xs'>{row.original.status || '—'}</span>
            {row.original.error ? (
              <span className='text-xs text-destructive'>
                {row.original.error}
              </span>
            ) : null}
          </div>
        ),
      },
    ],
    []
  )

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      pagination,
      columnFilters,
      columnVisibility,
      globalFilter: globalFilter ?? '',
    },
    onSortingChange: setSorting,
    onPaginationChange,
    onColumnFiltersChange,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange,
    globalFilterFn: 'includesString',
    getPaginationRowModel: getPaginationRowModel(),
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  // 页码超出范围就退回第一页（放在 effect 里，render 的时候别改路由）。
  useEffect(() => {
    ensurePageInRange(table.getPageCount())
  }, [table, ensurePageInRange])

  const filterValue = (columnId: string) => {
    const found = columnFilters.find((item) => item.id === columnId)
    const value = found?.value
    return typeof value === 'string' && value !== '' ? value : ALL
  }

  return (
    <div className='flex flex-col gap-4'>
      <DataTableToolbar
        table={table}
        searchPlaceholder='搜索模型或错误…'
        extra={
          <>
            <Select
              value={filterValue('upstream')}
              onValueChange={(value) =>
                table
                  .getColumn('upstream')
                  ?.setFilterValue(value === ALL ? undefined : value)
              }
            >
              <SelectTrigger className='h-8 w-40'>
                <SelectValue placeholder='全部 Provider' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部 Provider</SelectItem>
                {upstreamOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filterValue('model')}
              onValueChange={(value) =>
                table
                  .getColumn('model')
                  ?.setFilterValue(value === ALL ? undefined : value)
              }
            >
              <SelectTrigger className='h-8 w-40'>
                <SelectValue placeholder='全部模型' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部模型</SelectItem>
                {modelOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

      {isPending ? (
        <LoadingState label='正在加载明细…' />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : (
        <>
          <div className='rounded-md border'>
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder ? null : header.column.getCanSort() ? (
                          <DataTableColumnHeader
                            column={header.column}
                            title={String(header.column.columnDef.header ?? '')}
                          />
                        ) : (
                          flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )
                        )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={table.getAllColumns().length}
                      className='h-24 text-center text-muted-foreground'
                    >
                      没有匹配的记录。
                    </TableCell>
                  </TableRow>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <DataTablePagination table={table} />
        </>
      )}
    </div>
  )
}
