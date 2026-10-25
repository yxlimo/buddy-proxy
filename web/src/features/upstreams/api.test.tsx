import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { Code, ConnectError } from '@connectrpc/connect'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  AccountSchema,
  AddAccountResponseSchema,
  DeleteAccountResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  SetAccountEnabledResponseSchema,
  SetPlatformPolicyResponseSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import {
  useAddAccount,
  useDeleteAccount,
  useSetAccountEnabled,
  useSetPlatformPolicy,
  useUpstreams,
} from '@/features/upstreams/api'
import { AdminClientProvider } from '@/features/auth/client-provider'
import { mockAdminClient } from '@/test/mock-transport'
import { makeTestQueryClient } from '@/test/render'

function wrapper(client: ReturnType<typeof mockAdminClient>) {
  const queryClient = makeTestQueryClient()
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AdminClientProvider client={client}>{children}</AdminClientProvider>
    </QueryClientProvider>
  )
}

/** 一个平台：带上它名下的账号。 */
function platform() {
  return create(UpstreamSchema, {
    id: 'minimax',
    kind: 'minimax',
    label: 'MiniMax Code',
    region: 'cn',
    state: 1,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: 1,
    hasEnabledAccount: true,
    accounts: [
      create(AccountSchema, {
        id: 'minimax',
        platform: 'minimax',
        alias: '主账号',
        enabled: true,
        status: 'usable',
        credentialCount: 1,
      }),
    ],
  })
}

describe('上游页的 hook', () => {
  it('从假 transport 上取平台列表，账号跟着平台下来', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, { upstreams: [platform()] }),
    })

    const { result } = renderHook(() => useUpstreams(), {
      wrapper: wrapper(client),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data?.upstreams).toHaveLength(1)
    expect(result.current.data?.upstreams[0]?.id).toBe('minimax')
    expect(result.current.data?.upstreams[0]?.accounts[0]?.alias).toBe('主账号')
  })

  it('拨账号的开关，请求里带的是账号 id，改完把列表标成过期', async () => {
    let listCalls = 0
    const sent: { accountId: string; enabled: boolean }[] = []
    const client = mockAdminClient({
      ListUpstreams: () => {
        listCalls += 1
        return create(ListUpstreamsResponseSchema, { upstreams: [platform()] })
      },
      SetAccountEnabled: (input) => {
        sent.push({
          accountId: input.accountId ?? '',
          enabled: input.enabled ?? false,
        })
        return create(SetAccountEnabledResponseSchema, {
          ok: true,
          pendingRestart: false,
          message: '已保存，已经生效',
        })
      },
    })

    const { result } = renderHook(
      () => ({
        upstreams: useUpstreams(),
        setEnabled: useSetAccountEnabled(),
      }),
      { wrapper: wrapper(client) }
    )

    await waitFor(() => {
      expect(result.current.upstreams.isSuccess).toBe(true)
    })
    expect(listCalls).toBe(1)

    await result.current.setEnabled.mutateAsync({
      accountId: 'minimax',
      enabled: false,
    })

    expect(sent).toEqual([{ accountId: 'minimax', enabled: false }])
    await waitFor(() => {
      expect(listCalls).toBe(2)
    })
  })

  it('加账号带平台与别名，加完重取列表', async () => {
    let listCalls = 0
    const sent: { platform: string; alias: string }[] = []
    const client = mockAdminClient({
      ListUpstreams: () => {
        listCalls += 1
        return create(ListUpstreamsResponseSchema, { upstreams: [platform()] })
      },
      AddAccount: (input) => {
        sent.push({
          platform: input.platform ?? '',
          alias: input.alias ?? '',
        })
        return create(AddAccountResponseSchema, {
          ok: true,
          message: '加上了',
          id: 'minimax-2',
        })
      },
    })

    const { result } = renderHook(
      () => ({ upstreams: useUpstreams(), add: useAddAccount() }),
      { wrapper: wrapper(client) }
    )

    await waitFor(() => {
      expect(result.current.upstreams.isSuccess).toBe(true)
    })

    await result.current.add.mutateAsync({
      platform: 'minimax',
      alias: 'M plan',
    })

    expect(sent).toEqual([{ platform: 'minimax', alias: 'M plan' }])
    await waitFor(() => {
      expect(listCalls).toBe(2)
    })
  })

  it('加账号不给别名：请求里是空串，由服务端起名', async () => {
    const sent: string[] = []
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, { upstreams: [platform()] }),
      AddAccount: (input) => {
        sent.push(input.alias ?? '')
        return create(AddAccountResponseSchema, { ok: true, id: 'minimax-2' })
      },
    })

    const { result } = renderHook(() => useAddAccount(), {
      wrapper: wrapper(client),
    })

    await result.current.mutateAsync({ platform: 'minimax' })

    expect(sent).toEqual([''])
  })

  it('注销账号发的是账号 id', async () => {
    const sent: string[] = []
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, { upstreams: [platform()] }),
      DeleteAccount: (input) => {
        sent.push(input.id ?? '')
        return create(DeleteAccountResponseSchema, {
          ok: true,
          message: '删掉了，连带 1 条凭据',
        })
      },
    })

    const { result } = renderHook(() => useDeleteAccount(), {
      wrapper: wrapper(client),
    })

    await result.current.mutateAsync({ id: 'minimax' })

    expect(sent).toEqual(['minimax'])
  })

  it('改策略带平台 id 与策略', async () => {
    const sent: { platform: string; policy: ProviderPolicy }[] = []
    let listCalls = 0
    const client = mockAdminClient({
      ListUpstreams: () => {
        listCalls += 1
        return create(ListUpstreamsResponseSchema, { upstreams: [platform()] })
      },
      SetPlatformPolicy: (input) => {
        sent.push({
          platform: input.platform ?? '',
          policy: input.policy ?? ProviderPolicy.UNSPECIFIED,
        })
        return create(SetPlatformPolicyResponseSchema, {
          ok: true,
          message: '策略改成了降级',
        })
      },
    })

    const { result } = renderHook(
      () => ({ upstreams: useUpstreams(), setPolicy: useSetPlatformPolicy() }),
      { wrapper: wrapper(client) }
    )

    await waitFor(() => {
      expect(result.current.upstreams.isSuccess).toBe(true)
    })

    await result.current.setPolicy.mutateAsync({
      platform: 'minimax',
      policy: ProviderPolicy.FALLBACK,
    })

    expect(sent).toEqual([
      { platform: 'minimax', policy: ProviderPolicy.FALLBACK },
    ])
    // 改完列表重取回来：策略以服务端的答复为准。
    await waitFor(() => {
      expect(listCalls).toBe(2)
    })
  })

  it('服务端回 ok:false 的时候按失败处理，不当成功', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => create(ListUpstreamsResponseSchema, { upstreams: [] }),
      SetAccountEnabled: () =>
        create(SetAccountEnabledResponseSchema, {
          ok: false,
          message: '不认识这个账号：xxx',
        }),
    })

    const { result } = renderHook(() => useSetAccountEnabled(), {
      wrapper: wrapper(client),
    })

    await expect(
      result.current.mutateAsync({ accountId: 'nope', enabled: true })
    ).rejects.toThrow('不认识这个账号：xxx')
    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
  })

  it('网关报错的时候把错误交给界面', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => {
        // 真实链路里网关的错误就是 ConnectError，不是普通 Error。
        throw new ConnectError('网关炸了', Code.Internal)
      },
    })

    const { result } = renderHook(() => useUpstreams(), {
      wrapper: wrapper(client),
    })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect(result.current.error).toBeInstanceOf(ConnectError)
    expect(result.current.error?.message).toContain('网关炸了')
  })
})
