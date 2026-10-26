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
 * 环境变量钉住的设置。
 *
 * 部署里钉住的（环境变量）说了算，面板写的那份在库里等着 —— 面板要两个都
 * 看得见：一个是现在生效的，一个是它写下去等着的。
 */
describe('配置页：被环境变量挡着的设置', () => {
  it('生效的那份和面板写的那份都说清楚', async () => {
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
              overrideValue: 'false',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('是否开启 API KEY 验证')
    // 生效的是环境变量的值。
    expect(screen.getByText('true')).toBeInTheDocument()
    // 面板写的那份也在，并且说清了它在等。
    expect(screen.getByText(/面板里的值 false/)).toBeInTheDocument()
    expect(screen.getByText(/等它撤了才轮到这个/)).toBeInTheDocument()
    // 库里那份能清掉。
    expect(screen.getByRole('button', { name: /清回默认/ })).toBeInTheDocument()
  })

  it('没有被挡着的时候不说这些', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          pendingRestart: false,
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              label: '是否开启 API KEY 验证',
              value: 'false',
              source: 'database',
              fallback: 'false',
              group: 'gateway',
              description: '开启后，调用网关的 agent 必须带 API KEY。',
              overrideValue: 'false',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('是否开启 API KEY 验证')
    expect(screen.queryByText(/面板里的值/)).not.toBeInTheDocument()
  })
})
