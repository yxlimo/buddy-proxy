import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 平台的状态徽章按 state 显示。
 *
 * 能不能接由后端说（state），面板不自己拼「有账号 && 账号开着 && 登录了」。
 */
function platform(
  id: string,
  label: string,
  state: UpstreamState,
  hasEnabledAccount = false
) {
  return create(UpstreamSchema, {
    id,
    label,
    state,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: 0,
    hasEnabledAccount,
  })
}

describe('上游页的状态徽章', () => {
  it('按 state 显示', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            platform('ready', '就绪的那个', UpstreamState.READY, true),
            platform('off', '关着的那个', UpstreamState.DISABLED),
            platform('no-cred', '没登录的那个', UpstreamState.NO_CREDENTIAL),
            platform('no-money', '没额度的那个', UpstreamState.OUT_OF_CREDITS),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('就绪')).toBeInTheDocument()
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('没登录')).toBeInTheDocument()
    expect(screen.getByText('额度用完')).toBeInTheDocument()
  })

  it('登录过期了、登录被拒了、正在登录也各有各的说法', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            platform('expired', '过期的', UpstreamState.CREDENTIAL_EXPIRED),
            platform('rejected', '被拒的', UpstreamState.CREDENTIAL_REJECTED),
            platform('logging', '登录中的', UpstreamState.LOGGING_IN),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('登录过期了')).toBeInTheDocument()
    expect(screen.getByText('登录被拒了')).toBeInTheDocument()
    expect(screen.getByText('正在登录')).toBeInTheDocument()
  })

  it('冷却中：徽章说冷却中，还说为什么、到什么时候', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'qoder',
              label: 'Qoder 全球区',
              state: UpstreamState.COOLING,
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 1,
              hasEnabledAccount: true,
              cooldownUntilMs: 1793160000000n,
              cooldownReason: 'rate-limit',
              stateReason: '冷却到 12:23（rate-limit）',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('冷却中')).toBeInTheDocument()
    // 冷却中是黄色，跟额度用完（红色，不行）区分开。
    expect(screen.getByText('冷却中').className).toContain('amber')
    // 后端拼好的一句话：为什么现在不能接。
    expect(
      screen.getByText('冷却到 12:23（rate-limit）')
    ).toBeInTheDocument()
    // 冷却到什么时候。
    expect(screen.getAllByText(/^冷却到 /).length).toBeGreaterThan(0)
  })

  it('面板不自己拼状态：后端说没登录，就显示没登录', async () => {
    // 平台下有开着的账号，但后端说 state 是没登录 —— 面板照后端说。
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              state: UpstreamState.NO_CREDENTIAL,
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 1,
              hasEnabledAccount: true,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('没登录')).toBeInTheDocument()
    expect(screen.queryByText('就绪')).not.toBeInTheDocument()
  })
})
