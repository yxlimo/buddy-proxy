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
 * 契约里 Upstream.enabled 是「将要生效的值」，Upstream.pending 是「改过、
 * 还没重启」。面板不自己存一份开关状态，一切以服务端的答复为准。
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
              pending: false,
            }),
            create(UpstreamSchema, {
              id: 'qoder-cn',
              label: 'Qoder 中国区',
              enabled: false,
              pending: false,
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

  it('pending 为真的时候说清楚「重启后生效」', async () => {
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
    expect(screen.getAllByText('已保存，重启后生效').length).toBeGreaterThan(0)
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
              pending: enabled,
            }),
          ],
        }),
      SetUpstreamEnabled: (input) => {
        enabled = input.enabled ?? false
        return create(SetUpstreamEnabledResponseSchema, {
          ok: true,
          pendingRestart: true,
          message: '改了，重启后生效',
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
    expect(screen.getAllByText('已保存，重启后生效').length).toBeGreaterThan(0)
  })
})
