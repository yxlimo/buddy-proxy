import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ListUpstreamsResponseSchema,
  SetUpstreamEnabledResponseSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 上游的开关。
 *
 * 开关是热的：面板改完立刻生效，不用重启。所以界面上不再提「重启后生效」，
 * 也不看任何「待生效」的标志 —— 开关是热的，改完就生效。
 */
describe('上游的开关', () => {
  it('开关按服务端的 enabled 显示', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
            }),
            create(UpstreamSchema, {
              id: 'qoder-cn',
              label: 'Qoder 中国区',
              enabled: false,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    const minimax = await screen.findByRole('switch', {
      name: 'MiniMax Code 的开关',
    })
    const qoder = screen.getByRole('switch', { name: 'Qoder 中国区 的开关' })

    expect(minimax).toBeChecked()
    expect(qoder).not.toBeChecked()
  })

  it('界面上不再提「重启后生效」', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByRole('switch', { name: 'MiniMax Code 的开关' })
    expect(screen.queryByText(/重启后生效/)).not.toBeInTheDocument()
    expect(screen.queryByText(/重启网关/)).not.toBeInTheDocument()
  })

  it('就算 pending 是真的，也不提重启（那字段永远是假）', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
              pending: true,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByRole('switch', { name: 'MiniMax Code 的开关' })
    expect(screen.queryByText(/重启后生效/)).not.toBeInTheDocument()
  })

  it('拨开关之后重新取列表，状态以服务端的答复为准', async () => {
    const user = userEvent.setup()
    let enabled = false

    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled,
            }),
          ],
        }),
      SetUpstreamEnabled: (input) => {
        enabled = input.enabled ?? false
        return create(SetUpstreamEnabledResponseSchema, {
          ok: true,
          pendingRestart: false,
          message: '已保存，已经生效',
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    const minimax = await screen.findByRole('switch', {
      name: 'MiniMax Code 的开关',
    })
    expect(minimax).not.toBeChecked()

    await user.click(minimax)

    // 服务端说 enabled 了，界面就跟着变成开着的。
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'MiniMax Code 的开关' })
      ).toBeChecked()
    })
    // 不用重启。
    expect(screen.queryByText(/重启后生效/)).not.toBeInTheDocument()
  })
})
