import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  ConfigItemSchema,
  ListConfigResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { ConfigPage } from '@/features/config/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 待重启这件事只写在卡片说明里。
 *
 * 服务端说「有改了还没生效的东西」（pending_restart）时，卡片说明换成
 * 「改完要重启才生效」；页面上不出现「待重启」那种徽标文案。
 */
describe('配置页对待重启的提示', () => {
  it('就算 pending_restart 是真的，页面也不出现「待重启」这类徽标文案，只在卡片说明里说', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          pendingRestart: true,
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              label: '是否开启 API KEY 验证',
              value: 'true',
              source: 'environment',
              fallback: 'false',
              group: 'gateway',
              description: '开启后，调用网关的 agent 必须带 API KEY。',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('是否开启 API KEY 验证')
    // 页面上没有「待重启」这种徽标。
    expect(screen.queryByText(/待重启/)).not.toBeInTheDocument()
    expect(screen.queryByText(/重启网关/)).not.toBeInTheDocument()
    // 要重启这件事写在卡片说明里。
    expect(screen.getAllByText(/要重启才生效/).length).toBeGreaterThan(0)
  })

  it('pending_restart 为假的时候说改完立刻生效', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          pendingRestart: false,
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              label: '是否开启 API KEY 验证',
              value: 'true',
              source: 'environment',
              fallback: 'false',
              group: 'gateway',
              description: '开启后，调用网关的 agent 必须带 API KEY。',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('是否开启 API KEY 验证')
    expect(screen.getAllByText(/改完立刻生效/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/要重启才生效/)).not.toBeInTheDocument()
  })
})
