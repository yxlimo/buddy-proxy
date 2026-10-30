import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  BenefitStatusSchema,
  GetBenefitStatusResponseSchema,
  RunBenefitNowResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { BenefitStatus } from '@/gen/buddy/admin/v1/admin_pb'
import { DailyCheckinPanel } from '@/features/benefits/daily-checkin'
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

/** 一条签到状态。 */
function benefit(overrides: Partial<BenefitStatus> = {}): BenefitStatus {
  return create(BenefitStatusSchema, {
    upstreamId: 'minimax',
    summary: '签到成功',
    lines: [],
    checkedAt: 0n,
    credits: 0,
    ok: true,
    ...overrides,
  })
}

type Options = {
  /** 后端给的全部签到状态。 */
  benefits?: BenefitStatus[]
  /** 签到跑完返回的 lines。 */
  runLines?: string[]
  /** 签到跑完是不是成功。 */
  runOk?: boolean
}

/** 假客户端：记下每次请求。 */
function setup(options: Options = {}) {
  let statusCalls = 0
  let runCalls = 0

  const client = mockAdminClient({
    GetBenefitStatus: () => {
      statusCalls += 1
      return create(GetBenefitStatusResponseSchema, {
        benefits: options.benefits ?? [],
      })
    },
    RunBenefitNow: () => {
      runCalls += 1
      return create(RunBenefitNowResponseSchema, {
        ok: options.runOk ?? true,
        lines: options.runLines ?? [],
      })
    },
  })

  return {
    client,
    statusCalls: () => statusCalls,
    runCalls: () => runCalls,
  }
}

function renderPanel(client: ReturnType<typeof setup>['client']) {
  return renderWithClient({ client, children: <DailyCheckinPanel /> })
}

describe('DailyCheckinPanel', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
  })

  it('不同平台的账号各占一行', async () => {
    const { client } = setup({
      benefits: [
        benefit({ upstreamId: 'minimax' }),
        benefit({ upstreamId: 'qoder-cn' }),
      ],
    })

    renderPanel(client)

    expect(await screen.findByText('minimax')).toBeTruthy()
    expect(screen.getByText('qoder-cn')).toBeTruthy()
    expect(screen.getByText('每日签到')).toBeTruthy()
    // checkedAt = 0 的账号显示「还没签过」
    expect(screen.getAllByText('还没签过')).toHaveLength(2)
  })

  it('签到加了 12 积分时显示 +12 点', async () => {
    const { client } = setup({
      benefits: [benefit({ upstreamId: 'minimax', credits: 12 })],
    })

    renderPanel(client)

    expect(await screen.findByText('+12 点')).toBeTruthy()
  })

  it('没有签到账号时整块不渲染', async () => {
    const { client, statusCalls } = setup({ benefits: [] })

    renderPanel(client)

    await waitFor(() => {
      expect(statusCalls()).toBeGreaterThan(0)
    })
    expect(screen.queryByText('每日签到')).toBeNull()
    expect(screen.queryByRole('button', { name: '现在签到' })).toBeNull()
  })

  it('点「现在签到」会调 RunBenefitNow 并显示本次输出', async () => {
    const { client, runCalls, statusCalls } = setup({
      benefits: [benefit({ upstreamId: 'minimax' })],
      runLines: ['minimax: +12 点'],
    })

    renderPanel(client)

    const button = await screen.findByRole('button', { name: '现在签到' })
    await userEvent.click(button)

    await waitFor(() => {
      expect(runCalls()).toBe(1)
    })
    expect(await screen.findByText('本次签到')).toBeTruthy()
    expect(screen.getByText('minimax: +12 点')).toBeTruthy()

    // 签到跑完要重新取一次签到状态
    await waitFor(() => {
      expect(statusCalls()).toBeGreaterThan(1)
    })
  })
})
