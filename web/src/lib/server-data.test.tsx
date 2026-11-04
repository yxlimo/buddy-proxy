import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  DeleteAccountResponseSchema,
  GetBalanceResponseSchema,
  GetBenefitStatusResponseSchema,
  GetSystemStatusResponseSchema,
  ListUpstreamsResponseSchema,
  LoginWithPasswordResponseSchema,
  RunBenefitNowResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { AdminClientProvider } from '@/features/auth/client-provider'
import { useBalance } from '@/features/balance/api'
import { useLoginWithPassword } from '@/features/login/api'
import { useSystemStatus } from '@/features/overview/api'
import {
  useBenefitStatus,
  useRunBenefitNow,
} from '@/features/upstreams/benefits'
import {
  useDeleteAccount,
  useUpstreams,
} from '@/features/upstreams/api'
import { mockAdminClient } from '@/test/mock-transport'
import { makeTestQueryClient } from '@/test/render'

/**
 * 改完数据之后，读那摊数据的查询要真的再问服务端一次。
 *
 * 断的是「重取了几次」而不是「界面没崩」：一个 mutation 少让一份数据失效，
 * 界面上只是停在旧值上，看起来一切正常 —— 用户得手动刷页面才看得见自己的改动。
 */
function wrapper(client: ReturnType<typeof mockAdminClient>) {
  const queryClient = makeTestQueryClient()
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AdminClientProvider client={client}>{children}</AdminClientProvider>
    </QueryClientProvider>
  )
}

describe('改完数据，读它的查询重新取数', () => {
  it('登录写成一份凭据：平台那份答复与总览都重新取数', async () => {
    let listCalls = 0
    let statusCalls = 0
    const client = mockAdminClient({
      ListUpstreams: () => {
        listCalls += 1
        return create(ListUpstreamsResponseSchema, { upstreams: [] })
      },
      GetSystemStatus: () => {
        statusCalls += 1
        return create(GetSystemStatusResponseSchema, {})
      },
      LoginWithPassword: () =>
        create(LoginWithPasswordResponseSchema, {
          ok: true,
          message: '登录好了',
        }),
    })

    const { result } = renderHook(
      () => ({
        upstreams: useUpstreams(),
        status: useSystemStatus(),
        login: useLoginWithPassword(),
      }),
      { wrapper: wrapper(client) }
    )

    await waitFor(() => {
      expect(result.current.upstreams.isSuccess).toBe(true)
      expect(result.current.status.isSuccess).toBe(true)
    })
    expect(listCalls).toBe(1)
    expect(statusCalls).toBe(1)

    await result.current.login.mutateAsync({
      upstreamId: 'minimax',
      accountId: 'minimax',
      username: 'someone',
      password: 'secret',
      remember: true,
    })

    // 登录写成凭据之后，那一行从「没登录」变成「就绪」：这两份都得重取。
    await waitFor(() => {
      expect(listCalls).toBe(2)
    })
    expect(statusCalls).toBe(2)
  })

  it('签到：签到状态与额度都重新取数', async () => {
    let benefitCalls = 0
    let balanceCalls = 0
    const client = mockAdminClient({
      GetBenefitStatus: () => {
        benefitCalls += 1
        return create(GetBenefitStatusResponseSchema, { benefits: [] })
      },
      GetBalance: () => {
        balanceCalls += 1
        return create(GetBalanceResponseSchema, { quotas: [] })
      },
      RunBenefitNow: () =>
        create(RunBenefitNowResponseSchema, { ok: true, lines: [] }),
    })

    const { result } = renderHook(
      () => ({
        benefits: useBenefitStatus(),
        balance: useBalance(''),
        run: useRunBenefitNow(),
      }),
      { wrapper: wrapper(client) }
    )

    await waitFor(() => {
      expect(result.current.benefits.isSuccess).toBe(true)
      expect(result.current.balance.isSuccess).toBe(true)
    })
    expect(benefitCalls).toBe(1)
    expect(balanceCalls).toBe(1)

    await result.current.run.mutateAsync(undefined)

    // 签到签到手的积分在额度那份里，签没签在签到状态里。
    await waitFor(() => {
      expect(benefitCalls).toBe(2)
    })
    expect(balanceCalls).toBe(2)
  })

  it('注销账号：额度那份也重新取数（那个账号的卡没了）', async () => {
    let listCalls = 0
    let balanceCalls = 0
    const client = mockAdminClient({
      ListUpstreams: () => {
        listCalls += 1
        return create(ListUpstreamsResponseSchema, { upstreams: [] })
      },
      GetBalance: () => {
        balanceCalls += 1
        return create(GetBalanceResponseSchema, { quotas: [] })
      },
      DeleteAccount: () =>
        create(DeleteAccountResponseSchema, { ok: true, message: '删掉了' }),
    })

    const { result } = renderHook(
      () => ({
        upstreams: useUpstreams(),
        balance: useBalance(''),
        del: useDeleteAccount(),
      }),
      { wrapper: wrapper(client) }
    )

    await waitFor(() => {
      expect(result.current.upstreams.isSuccess).toBe(true)
      expect(result.current.balance.isSuccess).toBe(true)
    })
    expect(listCalls).toBe(1)
    expect(balanceCalls).toBe(1)

    await result.current.del.mutateAsync({ id: 'minimax' })

    await waitFor(() => {
      expect(listCalls).toBe(2)
    })
    expect(balanceCalls).toBe(2)
  })
})
