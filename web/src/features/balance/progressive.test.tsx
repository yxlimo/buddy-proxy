import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CreditSummarySchema,
  GetBalanceResponseSchema,
  UpstreamQuotaSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage } from '@/features/balance/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 一个账号的额度。 */
function quotaFor(upstreamId: string, accountId: string) {
  return create(UpstreamQuotaSchema, {
    upstreamId,
    accountId,
    credits: create(CreditSummarySchema, { total: 100, used: 0, remaining: 100 }),
  })
}

/**
 * 按上游并发拉额度：谁先回来谁先渲染。
 *
 * 整页等一次全量，慢的平台会把整页拖住；拆成一条上游一条查询之后，
 * 慢的那家只是它自己那张卡慢着。
 */
describe('额度按上游并发拉', () => {
  it('全量还没回来：先摆骨架卡片，页面本身已经在', async () => {
    const client = mockAdminClient({
      GetBalance: () => new Promise<never>(() => {}),
    })

    renderWithClient({ client, children: <BalancePage /> })

    expect(await screen.findByText('正在读取额度…')).toBeInTheDocument()
    // 页面标题在：不是整页转圈。
    expect(screen.getAllByText('额度').length).toBeGreaterThan(0)
  })

  it('先问一次全量认上游，再按上游各问一趟', async () => {
    const asked: string[] = []
    const client = mockAdminClient({
      GetBalance: (input) => {
        asked.push(input.upstreamId ?? '')
        const ids = input.upstreamId ? [input.upstreamId] : ['minimax', 'qoder']
        return create(GetBalanceResponseSchema, {
          quotas: ids.map((id) => quotaFor(id, `acc-${id}`)),
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByText('acc-minimax')
    await waitFor(() => {
      expect(asked.filter((id) => id === 'minimax')).toHaveLength(1)
      expect(asked.filter((id) => id === 'qoder')).toHaveLength(1)
    })
    // 全量只问一次，只用来认上游。
    expect(asked.filter((id) => id === '')).toHaveLength(1)
  })

  it('慢的那家自己慢着，快的那家先渲染', async () => {
    const client = mockAdminClient({
      GetBalance: (input) => {
        if (input.upstreamId === 'slow') return new Promise<never>(() => {})
        const ids = input.upstreamId ? [input.upstreamId] : ['fast', 'slow']
        return create(GetBalanceResponseSchema, {
          quotas: ids.map((id) => quotaFor(id, `acc-${id}`)),
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByText('acc-fast')
    // 慢的那家还没回来：卡还没出，也没报错。
    expect(screen.queryByText('acc-slow')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    // 慢的那家占着位置。
    expect(screen.getByText('slow')).toBeInTheDocument()
  })

  it('一家上游问崩了，只有它那张卡报错，别的卡照常', async () => {
    const client = mockAdminClient({
      GetBalance: (input) => {
        if (input.upstreamId === 'bad') throw new Error('这一家炸了')
        const ids = input.upstreamId ? [input.upstreamId] : ['good', 'bad']
        return create(GetBalanceResponseSchema, {
          quotas: ids.map((id) => quotaFor(id, `acc-${id}`)),
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    // 好的一家照常出数。
    await screen.findByText('acc-good')
    // 崩的那家自己报错，可以自己重试。
    await screen.findByRole(
      'button',
      { name: '重试' },
      { timeout: 15000 }
    )
    expect(screen.getByText('acc-good')).toBeInTheDocument()
  }, 20000)

  it('刷新之后各上游那条重新问一遍，卡片里的数换成新的', async () => {
    const user = userEvent.setup({ delay: null })
    const asked: { upstreamId: string; force: boolean }[] = []
    const client = mockAdminClient({
      GetBalance: (input) => {
        asked.push({ upstreamId: input.upstreamId ?? '', force: Boolean(input.force) })
        const ids = input.upstreamId ? [input.upstreamId] : ['minimax']
        return create(GetBalanceResponseSchema, {
          quotas: ids.map((id) => quotaFor(id, `acc-${id}`)),
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })
    await screen.findByText('acc-minimax')

    await user.click(screen.getByRole('button', { name: '刷新额度' }))

    await waitFor(() => {
      expect(asked.filter((c) => c.upstreamId === 'minimax')).toHaveLength(2)
    })
    // 刷新那一趟是带 force 的全量。
    expect(asked.some((c) => c.upstreamId === '' && c.force)).toBe(true)
  })
})
