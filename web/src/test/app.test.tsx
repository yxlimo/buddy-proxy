import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import {
  BalanceSummarySchema,
  GetBalanceResponseSchema,
  GetSystemStatusResponseSchema,
  GetUsageSummaryResponseSchema,
  ListUpstreamsResponseSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
  UsageBucketSchema,
  UsageSummarySchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { AdminClientProvider } from '@/features/auth/client-provider'
import { createAppRouter } from '@/router'
import { mockAdminClient } from '@/test/mock-transport'
import { makeTestQueryClient } from '@/test/render'

/**
 * 整个面板跑一遍：没有令牌的时候给令牌输入页，填了之后进总览。
 * 这里盯的是「有没有控制台报错」。
 */
describe('面板', () => {
  it('总览页能开起来，不报控制台错', async () => {
    const errors: unknown[][] = []
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args) => {
        errors.push(args)
      })

    const client = mockAdminClient({
      GetSystemStatus: () =>
        create(GetSystemStatusResponseSchema, {
          version: '1.0.0',
          uptimeSec: 3600n,
          publishedModelCount: 3,
          adminTokenSet: true,
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
              modelCount: 2,
            }),
          ],
        }),
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
              modelCount: 2,
            }),
          ],
        }),
      GetUsageSummary: () =>
        create(GetUsageSummaryResponseSchema, {
          total: create(UsageSummarySchema, {
            requests: 12n,
            succeeded: 10n,
            failed: 2n,
          }),
          byUpstream: [
            create(UsageBucketSchema, {
              key: 'minimax',
              summary: create(UsageSummarySchema, { requests: 12n }),
            }),
          ],
        }),
      GetBalance: () =>
        create(GetBalanceResponseSchema, {
          quotas: [
            create(UpstreamQuotaSchema, {
              upstreamId: 'tokenrhythm',
              accountId: 'tokenrhythm:1',
              balance: create(BalanceSummarySchema, {
                availableCny: 42.5,
                currency: 'CNY',
              }),
            }),
          ],
        }),
    })

    const queryClient = makeTestQueryClient()
    const router = createAppRouter(queryClient)

    render(
      <QueryClientProvider client={queryClient}>
        <AdminClientProvider client={client}>
          <RouterProvider router={router} />
        </AdminClientProvider>
      </QueryClientProvider>
    )

    // 侧边栏的导航在，标题也在
    await waitFor(
      () => {
        expect(
          screen.getByRole('heading', { name: '总览' })
        ).toBeInTheDocument()
      },
      // 整套测试一起跑的时候慢一点，别在这儿翻车。
      { timeout: 5000 }
    )
    expect(screen.getByText('网关管理面板')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '上游' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '配置' })).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: '账号与凭据' })
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '额度' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '用量' })).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: '主路由模型' })
    ).toBeInTheDocument()

    // 版本和模型数都从假网关上来了
    await waitFor(
      () => {
        expect(screen.getByText('版本 1.0.0')).toBeInTheDocument()
      },
      { timeout: 5000 }
    )
    expect(screen.getByText('12')).toBeInTheDocument()

    expect(errors).toEqual([])
    spy.mockRestore()
  })
})
