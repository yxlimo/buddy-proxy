import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Code, ConnectError } from '@connectrpc/connect'
import { UsageTable } from '@/features/usage/usage-table'

function renderTable(props: Partial<Parameters<typeof UsageTable>[0]> = {}) {
  return render(
    <UsageTable
      data={[]}
      search={{}}
      navigate={vi.fn()}
      upstreamOptions={[]}
      modelOptions={[]}
      {...props}
    />
  )
}

/**
 * 用量页是整个面板里最需要可信的一页：加载中、出错、真的是空，三种状态
 * 得让人分得出来。
 */
describe('用量明细的状态', () => {
  it('还在取的时候显示加载中，不说「没有记录」', () => {
    renderTable({ isPending: true })
    expect(screen.getByText('正在取明细…')).toBeInTheDocument()
    expect(screen.queryByText('没有匹配的记录。')).not.toBeInTheDocument()
  })

  it('取失败的时候显示错误，不说「没有记录」', () => {
    renderTable({
      error: new ConnectError('炸了', Code.Internal),
      onRetry: () => {},
    })
    expect(screen.getByText(/网关内部出错/)).toBeInTheDocument()
    expect(screen.queryByText('没有匹配的记录。')).not.toBeInTheDocument()
  })

  it('真的是空的时候才说没有记录', () => {
    renderTable()
    expect(screen.getByText('没有匹配的记录。')).toBeInTheDocument()
  })
})
