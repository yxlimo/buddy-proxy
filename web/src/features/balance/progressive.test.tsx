import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CreditSummarySchema,
  GetBalanceResponseSchema,
  ListUpstreamsResponseSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage } from '@/features/balance/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 平台清单：额度页的行集合。 */
function platformList(ids: string[]) {
  return create(ListUpstreamsResponseSchema, {
    upstreams: ids.map((id) => create(UpstreamSchema, { id })),
  })
}

/** 一个账号的额度。 */
function quotaFor(upstreamId: string, accountId: string) {
  return create(UpstreamQuotaSchema, {
    upstreamId,
    accountId,
    credits: create(CreditSummarySchema, { total: 100, used: 0, remaining: 100 }),
  })
}

/** 点开一个平台那一行，看它的明细。 */
async function openPlatform(upstreamId: string) {
  await userEvent
    .setup({ delay: null })
    .click(screen.getByRole('button', { name: new RegExp(`^${upstreamId}`) }))
}

/**
 * 按平台并发拉额度：谁先回来谁先渲染。
 *
 * 整页等一次全量，慢的平台会把整页拖住；拆成一条平台一条查询之后，
 * 慢的那家只是它自己那一行慢着。
 */
describe('额度按平台并发拉', () => {
  it('平台清单还没回来：先摆骨架行，页面本身已经在', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => new Promise<never>(() => {}),
    })

    renderWithClient({ client, children: <BalancePage /> })

    expect(await screen.findByText('正在读取额度…')).toBeInTheDocument()
    // 页面标题在：不是整页转圈。
    expect(screen.getAllByText('额度').length).toBeGreaterThan(0)
  })

  it('平台清单说一家问一趟：一家一次，没有额外的全量', async () => {
    const asked: string[] = []
    const client = mockAdminClient({
      ListUpstreams: () => platformList(['minimax', 'qoder']),
      GetBalance: (input) => {
        const upstreamId = input.upstreamId ?? ''
        asked.push(upstreamId)
        return create(GetBalanceResponseSchema, {
          quotas: upstreamId ? [quotaFor(upstreamId, `acc-${upstreamId}`)] : [],
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    // 两个平台各一行。
    await screen.findByRole('button', { name: /^minimax/ })
    await screen.findByRole('button', { name: /^qoder/ })
    await waitFor(() => {
      expect(asked).toEqual(['minimax', 'qoder'])
    })
  })

  it('慢的那家自己慢着，快的那家先渲染', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => platformList(['fast', 'slow']),
      GetBalance: (input) => {
        const upstreamId = input.upstreamId ?? ''
        if (upstreamId === 'slow') return new Promise<never>(() => {})
        return create(GetBalanceResponseSchema, {
          quotas: [quotaFor(upstreamId, `acc-${upstreamId}`)],
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    // 快的那家已经出数了。
    await screen.findByRole('button', { name: /^fast/ })
    await openPlatform('fast')
    expect(screen.getByText('acc-fast')).toBeInTheDocument()
    // 慢的那家还没回来：占着位置，也没报错。
    expect(screen.queryByText('acc-slow')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(
      screen.getByRole('listitem', { name: 'slow 额度行 正在读取' }),
    ).toBeInTheDocument()
  })

  it('一家平台问崩了，只有它那一行报错，别的照常', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => platformList(['good', 'bad']),
      GetBalance: (input) => {
        const upstreamId = input.upstreamId ?? ''
        if (upstreamId === 'bad') throw new Error('这一家炸了')
        return create(GetBalanceResponseSchema, {
          quotas: [quotaFor(upstreamId, `acc-${upstreamId}`)],
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    // 好的一家照常出数。
    await screen.findByRole('button', { name: /^good/ })
    // 崩的那家自己报错，可以自己重试。
    await screen.findByRole('button', { name: '重试' }, { timeout: 15000 })
    await openPlatform('good')
    expect(screen.getByText('acc-good')).toBeInTheDocument()
  }, 20000)

  it('所有平台都没问出来：给一个统一入口，点一次两家都重问', async () => {
    const user = userEvent.setup({ delay: null })
    const asked: string[] = []
    const client = mockAdminClient({
      ListUpstreams: () => platformList(['minimax', 'qoder']),
      GetBalance: (input) => {
        const upstreamId = input.upstreamId ?? ''
        asked.push(upstreamId)
        throw new Error('这一家炸了')
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    // 全家都挂了，统一入口出现。
    await screen.findByRole(
      'button',
      { name: '全部重试' },
      { timeout: 15000 }
    )
    expect(screen.getByText('所有平台都没问出来')).toBeInTheDocument()
    expect(asked.filter((id) => id === 'minimax')).toHaveLength(1)
    expect(asked.filter((id) => id === 'qoder')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '全部重试' }))

    // 两家都重新问了一遍，不用逐行点。
    await waitFor(
      () => {
        expect(asked.filter((id) => id === 'minimax')).toHaveLength(2)
        expect(asked.filter((id) => id === 'qoder')).toHaveLength(2)
      },
      { timeout: 5000 }
    )
  }, 20000)

  it('只有一家失败：不出统一入口，还是逐行各自报错', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => platformList(['good', 'bad']),
      GetBalance: (input) => {
        const upstreamId = input.upstreamId ?? ''
        if (upstreamId === 'bad') throw new Error('这一家炸了')
        return create(GetBalanceResponseSchema, {
          quotas: [quotaFor(upstreamId, `acc-${upstreamId}`)],
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByRole('button', { name: /^good/ })
    // 崩的那家自己报错，可以自己重试。
    await screen.findByRole('button', { name: '重试' }, { timeout: 15000 })
    // 只有一家失败：没有统一入口。
    expect(screen.queryByRole('button', { name: '全部重试' })).toBeNull()
    expect(screen.queryByText('所有平台都没问出来')).toBeNull()
  }, 20000)

  it('刷新之后各平台那条重新问一遍，行里的数换成新的', async () => {
    const user = userEvent.setup({ delay: null })
    const asked: { upstreamId: string; force: boolean }[] = []
    const client = mockAdminClient({
      ListUpstreams: () => platformList(['minimax']),
      GetBalance: (input) => {
        asked.push({ upstreamId: input.upstreamId ?? '', force: Boolean(input.force) })
        return create(GetBalanceResponseSchema, {
          quotas: [quotaFor('minimax', 'acc-minimax')],
        })
      },
    })

    renderWithClient({ client, children: <BalancePage /> })
    await screen.findByRole('button', { name: /^minimax/ })

    await user.click(screen.getByRole('button', { name: '刷新额度' }))

    await waitFor(() => {
      expect(asked.filter((c) => c.upstreamId === 'minimax')).toHaveLength(2)
    })
    // 刷新那一趟是带 force 的全量。
    expect(asked.some((c) => c.upstreamId === '' && c.force)).toBe(true)
  })
})
