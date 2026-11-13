import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  GetBalanceResponseSchema,
  ListUpstreamsResponseSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { BalancePage } from '@/features/balance/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: toastSuccess,
  }),
  Toaster: () => null,
}))

type Options = {
  /** 刷新那一趟一直不回来。 */
  hang?: boolean
  /** 刷新那一趟报错。 */
  fail?: boolean
}

type Call = { upstreamId: string; force: boolean }

/**
 * 假客户端：记下每次 GetBalance 问的是哪一家、带没带 force。
 *
 * 平台清单（ListUpstreams）说有一家 `minimax`：行集合来自它，额度再并进去。
 */
function setup(options: Options = {}) {
  const calls: Call[] = []
  const client = mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [create(UpstreamSchema, { id: 'minimax' })],
      }),
    GetBalance: (input) => {
      const force = Boolean(input.force)
      calls.push({ upstreamId: input.upstreamId ?? '', force })
      // 带 force 的那一趟是「刷新」，可以挂着也可以炸；别的照常回。
      if (force && options.hang) return new Promise<never>(() => {})
      if (force && options.fail) throw new Error('网关炸了')
      return create(GetBalanceResponseSchema, { quotas: [] })
    },
  })
  return { client, calls }
}

/** 页面到位的标志：金额那一家出了一行。 */
async function ready() {
  await screen.findByRole('button', { name: /^minimax/ })
}

describe('刷新额度', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
  })

  it('平时打开面板不强制问上游', async () => {
    const { client, calls } = setup()

    renderWithClient({ client, children: <BalancePage /> })
    await ready()

    expect(calls).toEqual([{ upstreamId: 'minimax', force: false }])
  })

  it('点「刷新额度」：带 force 去问一趟上游', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, calls } = setup()

    renderWithClient({ client, children: <BalancePage /> })
    await ready()

    await user.click(screen.getByRole('button', { name: '刷新额度' }))

    await waitFor(() => {
      expect(calls.some((call) => call.force)).toBe(true)
    })
    // 强制的那一趟是全量：不带 upstreamId。
    const forced = calls.filter((call) => call.force)
    expect(forced).toEqual([{ upstreamId: '', force: true }])
  })

  it('刷新的时候按钮禁用，字样是「正在刷新…」', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, calls } = setup({ hang: true })

    renderWithClient({ client, children: <BalancePage /> })
    await ready()

    await user.click(screen.getByRole('button', { name: '刷新额度' }))

    const running = await screen.findByRole('button', { name: '正在刷新…' })
    expect(running).toBeDisabled()
    // 刷新跑着的时候不会再发一趟。
    const during = calls.length
    await user.click(running)
    expect(calls.length).toBe(during)
  })

  it('刷新失败：说清失败，不假装刷成功', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({ fail: true })

    renderWithClient({ client, children: <BalancePage /> })
    await ready()

    await user.click(screen.getByRole('button', { name: '刷新额度' }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
