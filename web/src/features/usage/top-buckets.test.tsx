import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { BreakdownCard } from '@/features/usage/index'
import { USAGE_TOP_LIMIT, topBuckets } from '@/features/usage/top-buckets'

function bucket(key: string) {
  return {
    key,
    summary: { requests: 1n, promptTokens: 1n, completionTokens: 1n },
  }
}

function renderCard(buckets: number) {
  const { shown, total } = topBuckets(
    Array.from({ length: buckets }, (_, i) => bucket(`k${i}`))
  )
  return render(
    <BreakdownCard title='按子代理' buckets={shown} total={total} />
  )
}

describe('按主会话 / 按子代理只显示前 10', () => {
  it('正好 10 条时不显示总数提示', () => {
    renderCard(USAGE_TOP_LIMIT)
    expect(screen.getAllByText(/^k\d+$/)).toHaveLength(USAGE_TOP_LIMIT)
    expect(screen.queryByText(/共 \d+ 条/)).not.toBeInTheDocument()
  })

  it('超过 10 条时只渲染前 10 条，并提示总数', () => {
    const { container } = renderCard(USAGE_TOP_LIMIT + 1)
    expect(screen.getAllByText(/^k\d+$/)).toHaveLength(USAGE_TOP_LIMIT)
    expect(screen.queryByText('k10')).not.toBeInTheDocument()
    const card = container.firstChild as HTMLElement
    expect(within(card).getByText(`共 ${USAGE_TOP_LIMIT + 1} 条，显示前 ${USAGE_TOP_LIMIT}`)).toBeInTheDocument()
  })

  it('不足 10 条时不显示总数提示，条目全量渲染', () => {
    renderCard(3)
    expect(screen.getAllByText(/^k\d+$/)).toHaveLength(3)
    expect(screen.queryByText(/共 \d+ 条/)).not.toBeInTheDocument()
  })
})
