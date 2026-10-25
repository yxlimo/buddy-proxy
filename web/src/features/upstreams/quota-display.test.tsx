import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  BalanceSummarySchema,
  CreditSummarySchema,
  ListCredentialsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { Account } from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient as makeClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 账号的额度。
 *
 * 三样额度，单位不一样：套餐额度（百分比）、积分（点数）、余额（钱）。有套餐
 * 额度就显示套餐额度，没有才显示积分；余额有就另外显示。额度挂在账号上 ——
 * 同一个平台下的两个账号各有多少，是各自的数。
 */
function platform(accounts: Account[]) {
  return create(UpstreamSchema, {
    id: 'tokenrhythm',
    kind: 'tokenrhythm',
    label: 'TokenRhythm',
    state: UpstreamState.READY,
    policy: ProviderPolicy.EXPIRY_FIRST,
    policies: [ProviderPolicy.EXPIRY_FIRST],
    accountCount: accounts.length,
    hasEnabledAccount: true,
    accounts,
  })
}

/** 展开平台那一行，看它名下的账号。 */
async function openAccounts(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', {
      name: '展开 tokenrhythm 的账号与凭据',
    })
  )
}

describe('账号的额度', () => {
  it('积分、套餐额度、余额各按各的样子显示', async () => {
    const user = userEvent.setup({ delay: null })
    const client = makeClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            platform([
              create(AccountSchema, {
                id: 'tokenrhythm',
                platform: 'tokenrhythm',
                alias: '有点数的',
                enabled: true,
                status: 'usable',
                credentialCount: 1,
                quota: create(UpstreamQuotaSchema, {
                  credits: create(CreditSummarySchema, {
                    total: 2000,
                    used: 800,
                    remaining: 1200,
                  }),
                }),
              }),
              create(AccountSchema, {
                id: 'tokenrhythm-2',
                platform: 'tokenrhythm',
                alias: '有套餐的',
                enabled: true,
                status: 'usable',
                credentialCount: 1,
                quota: create(UpstreamQuotaSchema, {
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
              }),
              create(AccountSchema, {
                id: 'tokenrhythm-3',
                platform: 'tokenrhythm',
                alias: '有钱的',
                enabled: true,
                status: 'usable',
                credentialCount: 1,
                quota: create(UpstreamQuotaSchema, {
                  balance: create(BalanceSummarySchema, {
                    availableCny: 42.5,
                    currency: 'CNY',
                  }),
                }),
              }),
            ]),
          ],
        }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await openAccounts(user)
    await screen.findByText('有点数的')

    // 积分：点数。
    expect(screen.getByText('积分')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()

    // 套餐额度：百分比，两个窗口。
    expect(screen.getByText('套餐额度')).toBeInTheDocument()
    expect(screen.getByText(/5 小时 剩 72%/)).toBeInTheDocument()
    expect(screen.getByText(/每周 剩 15%/)).toBeInTheDocument()

    // 余额：钱。
    expect(screen.getByText('余额')).toBeInTheDocument()
    expect(screen.getByText('¥42.50')).toBeInTheDocument()
  })

  it('一个账号既有积分又有余额时，两个分开显示，不加起来', async () => {
    const user = userEvent.setup({ delay: null })
    const client = makeClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            platform([
              create(AccountSchema, {
                id: 'tokenrhythm',
                platform: 'tokenrhythm',
                alias: '租户一',
                enabled: true,
                status: 'usable',
                credentialCount: 1,
                quota: create(UpstreamQuotaSchema, {
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
              }),
            ]),
          ],
        }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await openAccounts(user)
    await screen.findByText('租户一')

    expect(screen.getByText('积分')).toBeInTheDocument()
    expect(screen.getByText('余额')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
    expect(screen.getByText('¥42.50')).toBeInTheDocument()
    // 没有把点数当钱加起来的那个数。
    expect(screen.queryByText(/1,?242\.50/)).not.toBeInTheDocument()
  })

  it('没有额度的账号给一个横杠', async () => {
    const user = userEvent.setup({ delay: null })
    const client = makeClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            platform([
              create(AccountSchema, {
                id: 'tokenrhythm',
                platform: 'tokenrhythm',
                alias: '租户一',
                enabled: true,
                status: 'usable',
                credentialCount: 1,
              }),
            ]),
          ],
        }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await openAccounts(user)
    await screen.findByText('租户一')

    expect(screen.queryByText('积分')).not.toBeInTheDocument()
    expect(screen.queryByText('套餐额度')).not.toBeInTheDocument()
    expect(screen.queryByText('余额')).not.toBeInTheDocument()
  })

  it('有套餐额度就显示套餐额度，不并列显示积分', async () => {
    const user = userEvent.setup({ delay: null })
    const client = makeClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            platform([
              create(AccountSchema, {
                id: 'minimax',
                platform: 'minimax',
                alias: '主账号',
                enabled: true,
                status: 'usable',
                credentialCount: 1,
                quota: create(UpstreamQuotaSchema, {
                  tokenPlan: create(TokenPlanSchema, {
                    windows: [
                      create(TokenPlanWindowSchema, {
                        label: 'general',
                        intervalPercent: 72,
                        weeklyPercent: 15,
                      }),
                    ],
                  }),
                  credits: create(CreditSummarySchema, {
                    total: 2000,
                    used: 800,
                    remaining: 1200,
                  }),
                }),
              }),
            ]),
          ],
        }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await openAccounts(user)
    await screen.findByText('主账号')

    expect(screen.getByText('套餐额度')).toBeInTheDocument()
    expect(screen.queryByText('积分')).not.toBeInTheDocument()
  })
})