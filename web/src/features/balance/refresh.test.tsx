import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GetBalanceResponseSchema } from '@/gen/buddy/admin/v1/admin_pb'
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

/** 假客户端：记下每次 GetBalance 带的是不是 force。 */
function setup(options: Options = {}) {
  const calls: boolean[] = []
  const client = mockAdminClient({
    GetBalance: (input) => {
      calls.push(Boolean(input.force))
      // 第一次是页面自己取的额度，后面的才是「刷新」。
      if (calls.length > 1 && options.hang) return new Promise<never>(() => {})
      if (calls.length > 1 && options.fail) throw new Error('网关炸了')
      return create(GetBalanceResponseSchema, { quotas: [] })
    },
  })
  return { client, calls }
}

describe('刷新额度', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
  })

  it('平时打开面板不强制问上游', async () => {
    const { client, calls } = setup()

    renderWithClient({ client, children: <BalancePage /> })

    expect(await screen.findByText('Provider 没有报额度。')).toBeInTheDocument()
    expect(calls).toEqual([false])
  })

  it('点「刷新额度」：带 force 去问一趟上游', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, calls } = setup()

    renderWithClient({ client, children: <BalancePage /> })
    await screen.findByText('Provider 没有报额度。')

    await user.click(screen.getByRole('button', { name: '刷新额度' }))

    await waitFor(() => {
      expect(calls).toEqual([false, true])
    })
  })

  it('刷新的时候按钮禁用，字样是「正在刷新…」', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, calls } = setup({ hang: true })

    renderWithClient({ client, children: <BalancePage /> })
    await screen.findByText('Provider 没有报额度。')

    await user.click(screen.getByRole('button', { name: '刷新额度' }))

    const running = await screen.findByRole('button', { name: '正在刷新…' })
    expect(running).toBeDisabled()
    // 刷新跑着的时候不会再发一趟。
    await user.click(running)
    expect(calls).toEqual([false, true])
  })

  it('刷新失败：说清失败，不假装刷成功', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({ fail: true })

    renderWithClient({ client, children: <BalancePage /> })
    await screen.findByText('Provider 没有报额度。')

    await user.click(screen.getByRole('button', { name: '刷新额度' }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
