import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { Code, ConnectError } from '@connectrpc/connect'
import {
  ListUpstreamsResponseSchema,
  SetUpstreamEnabledResponseSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { useSetUpstreamEnabled, useUpstreams } from '@/features/upstreams/api'
import { AdminClientProvider } from '@/features/auth/client-provider'
import { mockAdminClient } from '@/test/mock-transport'
import { makeTestQueryClient } from '@/test/render'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

function wrapper(client: ReturnType<typeof mockAdminClient>) {
  const queryClient = makeTestQueryClient()
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AdminClientProvider client={client}>{children}</AdminClientProvider>
    </QueryClientProvider>
  )
}

describe('上游的 hook', () => {
  it('从假 transport 上取上游列表', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
              modelCount: 2,
            }),
            create(UpstreamSchema, {
              id: 'qoder-cn',
              label: 'Qoder 中国区',
              enabled: false,
              modelCount: 5,
            }),
          ],
        }),
    })

    const { result } = renderHook(() => useUpstreams(), {
      wrapper: wrapper(client),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data?.upstreams).toHaveLength(2)
    expect(result.current.data?.upstreams[0]?.id).toBe('minimax')
    expect(result.current.data?.upstreams[1]?.enabled).toBe(false)
  })

  it('改开关之后把上游列表标成过期，好让界面重新取', async () => {
    let listCalls = 0
    const client = mockAdminClient({
      ListUpstreams: () => {
        listCalls += 1
        return create(ListUpstreamsResponseSchema, { upstreams: [] })
      },
      SetUpstreamEnabled: () =>
        create(SetUpstreamEnabledResponseSchema, {
          ok: true,
          pendingRestart: true,
          message: '改了，重启后生效',
        }),
    })

    const { result } = renderHook(
      () => ({
        upstreams: useUpstreams(),
        setEnabled: useSetUpstreamEnabled(),
      }),
      { wrapper: wrapper(client) }
    )

    await waitFor(() => {
      expect(result.current.upstreams.isSuccess).toBe(true)
    })
    expect(listCalls).toBe(1)

    await result.current.setEnabled.mutateAsync({
      upstreamId: 'minimax',
      enabled: false,
    })

    await waitFor(() => {
      expect(listCalls).toBe(2)
    })
  })

  it('服务端回 ok:false 的时候按失败处理，不当成功', async () => {
    const client = mockAdminClient({
      ListUpstreams: () => create(ListUpstreamsResponseSchema, { upstreams: [] }),
      SetUpstreamEnabled: () =>
        create(SetUpstreamEnabledResponseSchema, {
          ok: false,
          message: '不认识的上游：xxx',
        }),
    })

    const { result } = renderHook(() => useSetUpstreamEnabled(), {
      wrapper: wrapper(client),
    })

    await expect(
      result.current.mutateAsync({ upstreamId: 'nope', enabled: true })
    ).rejects.toThrow('不认识的上游：xxx')
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
