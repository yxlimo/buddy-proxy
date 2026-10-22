import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  CredentialState,
  CredentialStatusSchema,
  ListUpstreamsResponseSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 上游的状态徽章按 state 显示。
 *
 * 能不能接由后端说（state），面板不再自己拼「开着 && 登录了」。
 */
describe('上游页的状态徽章', () => {
  it('按 state 显示', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'ready',
              label: '就绪的那个',
              enabled: true,
              state: UpstreamState.READY,
            }),
            create(UpstreamSchema, {
              id: 'off',
              label: '关着的那个',
              enabled: false,
              state: UpstreamState.DISABLED,
            }),
            create(UpstreamSchema, {
              id: 'no-cred',
              label: '没登录的那个',
              enabled: true,
              state: UpstreamState.NO_CREDENTIAL,
              credential: create(CredentialStatusSchema, {
                status: CredentialState.MISSING,
                kind: 'session',
              }),
            }),
            create(UpstreamSchema, {
              id: 'no-money',
              label: '没额度的那个',
              enabled: true,
              state: UpstreamState.OUT_OF_CREDITS,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('就绪')).toBeInTheDocument()
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('没登录')).toBeInTheDocument()
    expect(screen.getByText('额度用完')).toBeInTheDocument()
    // 凭据状态也按枚举来（不是字符串）。
    expect(screen.getByText('缺失')).toBeInTheDocument()
  })

  it('登录过期了、登录被拒了、正在登录也各有各的说法', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'expired',
              label: '过期的',
              state: UpstreamState.CREDENTIAL_EXPIRED,
            }),
            create(UpstreamSchema, {
              id: 'rejected',
              label: '被拒的',
              state: UpstreamState.CREDENTIAL_REJECTED,
            }),
            create(UpstreamSchema, {
              id: 'logging',
              label: '登录中的',
              state: UpstreamState.LOGGING_IN,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('登录过期了')).toBeInTheDocument()
    expect(screen.getByText('登录被拒了')).toBeInTheDocument()
    expect(screen.getByText('正在登录')).toBeInTheDocument()
  })
})
