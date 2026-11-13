import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  BalanceLotSchema,
  BalanceSummarySchema,
  CreditLotSchema,
  CreditSummarySchema,
  GetBalanceResponseSchema,
  ListUpstreamsResponseSchema,
  type UpstreamQuota,
  UpstreamQuotaSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage } from '@/features/balance/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const EXPIRES_AT = BigInt(Date.UTC(2030, 0, 15))

type Client = ReturnType<typeof mockAdminClient>

/** 假客户端：一家平台的清单，加上这一家的额度。 */
function clientWith(upstreamId: string, quotas: UpstreamQuota[]) {
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [create(UpstreamSchema, { id: upstreamId, label: upstreamId })],
      }),
    GetBalance: () => create(GetBalanceResponseSchema, { quotas }),
  })
}

/** 摆一个平台，点开它的明细。明细区就是那一份额度。 */
async function openPlatform(client: Client, upstreamId: string) {
  renderWithClient({ client, children: <BalancePage /> })
  await userEvent
    .setup({ delay: null })
    .click(
      await screen.findByRole('button', { name: new RegExp(`^${upstreamId}`) }),
    )
  return screen.getByRole('region', { name: `${upstreamId} 额度明细` })
}

/**
 * 额度分三种：余额（钱）、积分（点数）、套餐额度（百分比）。
 *
 * 三者不叠加、不换算、不求和 —— 单位不同，加起来的数没有意义。
 */
describe('额度按种类渲染', () => {
  it('积分账号显示点数，不写成钱', async () => {
    const client = clientWith('qoder-cn', [
      create(UpstreamQuotaSchema, {
        upstreamId: 'qoder-cn',
        accountId: 'qoder-cn',
        credits: create(CreditSummarySchema, {
          total: 2000,
          used: 800,
          remaining: 1200,
          note: '每天 100 点，连签 3 天',
          lots: [
            create(CreditLotSchema, {
              id: 'credit-1',
              sourceLabel: '套餐额度',
              remaining: 1200,
              expiresAt: EXPIRES_AT,
              status: 'active',
            }),
          ],
        }),
      }),
    ])

    const detail = await openPlatform(client, 'qoder-cn')

    expect(within(detail).getByText('积分')).toBeInTheDocument()
    // 剩余、总额、已用都是点数。
    expect(within(detail).getAllByText('1,200 点').length).toBeGreaterThan(0)
    expect(within(detail).getByText('2,000 点')).toBeInTheDocument()
    expect(within(detail).getByText('800 点')).toBeInTheDocument()
    // 明细也在。
    expect(within(detail).getByText('credit-1')).toBeInTheDocument()
    expect(
      within(detail).getByText('每天 100 点，连签 3 天'),
    ).toBeInTheDocument()
    // 点数不是钱。
    expect(within(detail).queryByText(/¥/)).not.toBeInTheDocument()
  })

  it('平台没报总额的时候不硬凑总额和已用', async () => {
    const client = clientWith('workbuddy-cn', [
      create(UpstreamQuotaSchema, {
        upstreamId: 'workbuddy-cn',
        accountId: 'workbuddy-cn',
        credits: create(CreditSummarySchema, {
          total: 0,
          used: 0,
          remaining: 42,
        }),
      }),
    ])

    const detail = await openPlatform(client, 'workbuddy-cn')

    expect(within(detail).getByText('积分')).toBeInTheDocument()
    expect(within(detail).getByText('42 点')).toBeInTheDocument()
    expect(within(detail).queryByText('总额')).not.toBeInTheDocument()
    expect(within(detail).queryByText('已用')).not.toBeInTheDocument()
  })

  it('余额账号显示钱、明细、最早到期和会过期的那部分', async () => {
    const client = clientWith('tokenrhythm', [
      create(UpstreamQuotaSchema, {
        upstreamId: 'tokenrhythm',
        accountId: 'tokenrhythm:1',
        balance: create(BalanceSummarySchema, {
          availableCny: 42.5,
          currency: 'CNY',
          nextExpiryAt: EXPIRES_AT,
          expiringCny: 10,
          lots: [
            create(BalanceLotSchema, {
              id: 'balance-1',
              sourceLabel: '新人活动',
              remainingCny: 42.5,
              expiresAt: EXPIRES_AT,
              status: 'active',
            }),
          ],
        }),
      }),
    ])

    const detail = await openPlatform(client, 'tokenrhythm')

    expect(within(detail).getByText('最早到期')).toBeInTheDocument()
    expect(within(detail).getByText('余额')).toBeInTheDocument()
    expect(within(detail).getAllByText('¥42.50').length).toBeGreaterThan(0)
    expect(within(detail).getByText('会过期的那部分')).toBeInTheDocument()
    expect(within(detail).getByText('¥10.00')).toBeInTheDocument()
    expect(within(detail).getByText('balance-1')).toBeInTheDocument()
  })

  it('积分和余额各是各的，不加在一起', async () => {
    const client = clientWith('tokenrhythm', [
      create(UpstreamQuotaSchema, {
        upstreamId: 'tokenrhythm',
        accountId: 'tokenrhythm:1',
        credits: create(CreditSummarySchema, {
          total: 1200,
          used: 0,
          remaining: 1200,
        }),
        balance: create(BalanceSummarySchema, {
          availableCny: 42.5,
          currency: 'CNY',
        }),
      }),
    ])

    const detail = await openPlatform(client, 'tokenrhythm')

    expect(within(detail).getByText('积分')).toBeInTheDocument()
    expect(within(detail).getByText('余额')).toBeInTheDocument()
    // 两个数都在。
    expect(within(detail).getAllByText('1,200 点').length).toBeGreaterThan(0)
    expect(within(detail).getAllByText('¥42.50').length).toBeGreaterThan(0)
    // 没有加起来的那个数。
    expect(within(detail).queryAllByText(/1,?242\.50/)).toHaveLength(0)
    expect(within(detail).queryAllByText(/¥1,?242\.50/)).toHaveLength(0)
  })

  it('平台清单本身是空的时候给空状态', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => create(ListUpstreamsResponseSchema, {}),
      GetBalance: () => create(GetBalanceResponseSchema, {}),
    })

    renderWithClient({ client, children: <BalancePage /> })

    expect(await screen.findByText('网关没有返回任何平台')).toBeInTheDocument()
  })
})

/**
 * 明细里每个账号写它的名字，没名字才退回 id。
 *
 * 光看 id 认不出是哪个账号：同一个平台下几个账号的 id 都是序号。
 */
describe('明细里的账号写名字', () => {
  function credits() {
    return create(CreditSummarySchema, { total: 100, used: 0, remaining: 100 })
  }

  it('有名字：写名字，副行补账号 id', async () => {
    const client = clientWith('minimax', [
      create(UpstreamQuotaSchema, {
        upstreamId: 'minimax',
        accountId: '8',
        accountName: 'Token Plan',
        credits: credits(),
      }),
    ])

    const detail = await openPlatform(client, 'minimax')

    // 名字当标题，裸 id 不当标题。
    expect(within(detail).getByText('Token Plan')).toBeInTheDocument()
    expect(within(detail).queryByText('8')).toBeNull()
    // 副行交代这条额度属于哪个账号。
    expect(within(detail).getByText('账号 8')).toBeInTheDocument()
  })

  it('账号 id 与平台 id 相同：副行不重复写', async () => {
    const client = clientWith('qoder-cn', [
      create(UpstreamQuotaSchema, {
        upstreamId: 'qoder-cn',
        accountId: 'qoder-cn',
        accountName: 'Sync Bot',
        credits: credits(),
      }),
    ])

    const detail = await openPlatform(client, 'qoder-cn')

    expect(within(detail).getByText('Sync Bot')).toBeInTheDocument()
    // 平台 id 行上已经写过了，明细里不再写一遍。
    expect(within(detail).queryByText(/qoder-cn/)).toBeNull()
    expect(within(detail).queryByText(/账号 qoder-cn/)).toBeNull()
  })

  it('没名字：标题退回账号 id，不再补一段重复的账号 id', async () => {
    const client = clientWith('minimax', [
      create(UpstreamQuotaSchema, {
        upstreamId: 'minimax',
        accountId: '8',
        accountName: '',
        credits: credits(),
      }),
    ])

    const detail = await openPlatform(client, 'minimax')

    expect(within(detail).getByText('8')).toBeInTheDocument()
    // 没名字就没有「账号 8」这种半截，也不会冒出空串或多余的分隔符。
    expect(within(detail).queryByText(/账号 8/)).toBeNull()
    expect(within(detail).queryByText(/· 账号/)).toBeNull()
    expect(within(detail).queryByText(/^·/)).toBeNull()
  })
})
