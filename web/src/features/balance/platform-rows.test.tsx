import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  BalanceSummarySchema,
  CreditSummarySchema,
  GetBalanceResponseSchema,
  ListUpstreamsResponseSchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage } from '@/features/balance/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 平台清单里的一行。额度页的行集合来自它。 */
function platform(id: string, label = '') {
  return create(UpstreamSchema, { id, label })
}

/** 一份平台清单：`ListUpstreams` 的答复。 */
function platformList(upstreams: ReturnType<typeof platform>[]) {
  return create(ListUpstreamsResponseSchema, { upstreams })
}

/** 一条积分额度。 */
function creditsQuota(
  upstreamId: string,
  accountId: string,
  remaining: number,
  accountName = '',
) {
  return create(UpstreamQuotaSchema, {
    upstreamId,
    accountId,
    accountName,
    credits: create(CreditSummarySchema, {
      total: 0,
      used: 0,
      remaining,
    }),
  })
}

/**
 * 一个平台一行。
 *
 * 收起时行上只有摘要（平台名、账号数、最有信息量的那一档额度）；点开这一行
 * 才看各账号的明细。
 */
describe('一个平台一行', () => {
  it('同一平台的两个账号收在一行里', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => platformList([platform('tokenrhythm')]),
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            creditsQuota('tokenrhythm', 'tenant-1', 1200, '租户一'),
            creditsQuota('tokenrhythm', 'tenant-2', 800, '租户二'),
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    // 一行：平台名出现一次，账号数写在摘要里。
    const row = await screen.findByRole('listitem', {
      name: 'tokenrhythm 额度行',
    })
    expect(within(row).getByText('2 个账号')).toBeInTheDocument()
    // 收起时不摆账号名。
    expect(screen.queryByText('租户一')).toBeNull()
    expect(screen.queryByText('租户二')).toBeNull()
  })

  it('默认收起：明细不在，点开才出现', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      ListUpstreams: () => platformList([platform('qoder-cn')]),
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [creditsQuota('qoder-cn', 'acc-1', 1200)],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    const toggle = await screen.findByRole('button', { name: /^qoder-cn/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('region', { name: 'qoder-cn 额度明细' }),
    ).toBeNull()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const detail = screen.getByRole('region', { name: 'qoder-cn 额度明细' })
    expect(within(detail).getByText('1,200 点')).toBeInTheDocument()

    // 再点收起来。
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('region', { name: 'qoder-cn 额度明细' }),
    ).toBeNull()
  })

  it('摘要挑最有信息量的那一档：有套餐额度就写套餐额度', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => platformList([platform('minimax')]),
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            // 一个只有余额的账号排在前，摘要仍应挑有套餐额度的那个。
            create(UpstreamQuotaSchema, {
              upstreamId: 'minimax',
              accountId: 'acc-money',
              balance: create(BalanceSummarySchema, {
                availableCny: 8,
                currency: 'CNY',
              }),
            }),
            create(UpstreamQuotaSchema, {
              upstreamId: 'minimax',
              accountId: 'acc-plan',
              tokenPlan: create(TokenPlanSchema, {
                windows: [
                  create(TokenPlanWindowSchema, {
                    label: 'general',
                    intervalPercent: 72,
                    weeklyPercent: 15,
                  }),
                ],
              }),
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    const row = await screen.findByRole('listitem', {
      name: 'minimax 额度行',
    })
    expect(within(row).getByText(/剩 72%/)).toBeInTheDocument()
  })
})

/**
 * 行集合来自平台清单，不是额度答复。
 *
 * 左连接：额度答复里没有它、它名下也没有账号的平台，照样有一行。
 */
describe('行集合来自平台清单', () => {
  it('额度答复里只有别家：这一家还是有行，写没有额度', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        platformList([platform('minimax'), platform('sense-nova')]),
      GetBalance: (input) =>
        create(GetBalanceResponseSchema, {
          // 问 sense-nova 也一条不回：它的答复是空的。
          quotas:
            (input.upstreamId ?? '') === 'minimax'
              ? [creditsQuota('minimax', 'acc-1', 100)]
              : [],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByRole('button', { name: /^minimax/ })
    const row = screen.getByRole('listitem', { name: 'sense-nova 额度行' })
    await waitFor(() => {
      expect(row).toHaveTextContent('没有额度')
    })
  })

  it('额度还在读：写正在读取，不是没有额度', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => platformList([platform('minimax')]),
      // 平台清单到了，这一家的额度还没回来。
      GetBalance: () => new Promise<never>(() => {}),
    })

    renderWithClient({ client, children: <BalancePage /> })

    const row = await screen.findByRole('listitem', {
      name: 'minimax 额度行 正在读取',
    })
    expect(row).toHaveTextContent('正在读取')
    expect(row).not.toHaveTextContent('没有额度')
  })

  it('标题用平台的显示名，行容器仍按 id 定位', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        platformList([platform('minimax', 'MiniMax Code')]),
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [creditsQuota('minimax', 'acc-1', 100)],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    const row = await screen.findByRole('listitem', {
      name: 'minimax 额度行',
    })
    expect(within(row).getByText('MiniMax Code')).toBeInTheDocument()
    // 显示名不是 id：id 只出现在 aria-label 里。
    expect(within(row).queryByText('minimax')).toBeNull()
  })

  it('平台没设名字：标题退回 id', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => platformList([platform('qoder', '')]),
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [creditsQuota('qoder', 'acc-1', 100)],
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    const row = await screen.findByRole('listitem', { name: 'qoder 额度行' })
    expect(within(row).getByText('qoder')).toBeInTheDocument()
  })
})

/**
 * 空额度不隐掉：没有数字的平台也占一行，说「没有额度」，不写成 0。
 */
describe('空额度占一行', () => {
  it('平台没有报额度：这一行还在，写着没有额度', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => platformList([platform('zcode')]),
      GetBalance: () => create(GetBalanceResponseSchema, { quotas: [] }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    const toggle = await screen.findByRole('button', { name: /^zcode/ })
    await waitFor(() => {
      expect(toggle).toHaveTextContent('没有额度')
    })
    // 不是 0。
    expect(toggle).not.toHaveTextContent('0 点')

    await userEvent.setup({ delay: null }).click(toggle)
    const detail = screen.getByRole('region', { name: 'zcode 额度明细' })
    expect(
      within(detail).getByRole('note', { name: '没有额度' }),
    ).toBeInTheDocument()
  })

  it('服务端给了结论：行上写服务端给的那一句', async () => {
    const noQuota = create(UpstreamQuotaSchema, {
      upstreamId: 'zcode',
      accountId: 'acc-1',
      quotaState: 'no_quota',
    })
    const client = mockAdminClient({
      ListUpstreams: () => platformList([platform('zcode')]),
      GetBalance: () =>
        create(GetBalanceResponseSchema, { quotas: [noQuota] }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    const toggle = await screen.findByRole('button', { name: /^zcode/ })
    expect(toggle).toHaveTextContent('额度用尽')
  })
})

/**
 * 收起时只摆前 5 个平台，其余收在「展开全部」后面。
 */
describe('收起时只摆前 5 个平台', () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']

  function client() {
    return mockAdminClient({
      ListUpstreams: () => platformList(ids.map((id) => platform(id))),
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: ids.map((id, index) =>
            creditsQuota(id, `${id}-acc`, 100 - index),
          ),
        }),
    })
  }

  it('只摆前 5 行，其余在展开全部后面', async () => {
    renderWithClient({ client: client(), children: <BalancePage /> })

    await screen.findByRole('listitem', { name: 'p5 额度行' })
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(screen.queryByRole('listitem', { name: 'p6 额度行' })).toBeNull()
    expect(
      screen.getByRole('button', { name: '展开全部 7 个平台' }),
    ).toBeInTheDocument()
  })

  it('点展开全部：7 行都在，再点收起回到 5 行', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: client(), children: <BalancePage /> })

    await screen.findByRole('listitem', { name: 'p5 额度行' })
    await user.click(screen.getByRole('button', { name: '展开全部 7 个平台' }))

    expect(screen.getAllByRole('listitem')).toHaveLength(7)
    expect(screen.getByRole('listitem', { name: 'p7 额度行' })).toBeInTheDocument()
    // 展开之后就没有「展开全部」了。
    expect(
      screen.queryByRole('button', { name: '展开全部 7 个平台' }),
    ).toBeNull()

    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('平台不到 5 个：没有展开全部', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        platformList(ids.slice(0, 3).map((id) => platform(id))),
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: ids.slice(0, 3).map((id) => creditsQuota(id, `${id}-acc`, 10)),
        }),
    })

    renderWithClient({ client, children: <BalancePage /> })

    await screen.findByRole('listitem', { name: 'p3 额度行' })
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /展开全部/ })).toBeNull()
  })
})
