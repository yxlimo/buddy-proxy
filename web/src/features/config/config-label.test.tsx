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
 * 配置页不该把 env 键名甩给人。
 *
 * 契约里 ConfigItem.label 是自然语言的名字（「MiniMax Code 上游」这种）。
 * 没有 label 就退回 description 的第一句。
 */
describe('配置页的名字', () => {
  it('主要显示是 label，键名放在次要位置', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'MINIMAX_CODE_ENABLED',
              label: 'MiniMax Code 上游',
              value: 'true',
              source: 'default',
              fallback: 'true',
              group: 'general',
              description: '要不要开 MiniMax Code 这个上游',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('MiniMax Code 上游')
    // 键名还在，但在次要位置（更小更灰的那一行）。
    expect(screen.getByText('MINIMAX_CODE_ENABLED')).toBeInTheDocument()
    expect(screen.getByText('MINIMAX_CODE_ENABLED').className).toContain(
      'text-muted-foreground'
    )
  })

  it('没有 label 就用 description 的第一句', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'MINIMAX_CODE_ENABLED',
              label: '',
              value: 'true',
              source: 'default',
              fallback: 'true',
              group: 'general',
              description: '要不要开 MiniMax Code 这个上游。改完要重启。',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('要不要开 MiniMax Code 这个上游')
    // 描述的第一句当了标题，剩下那半句在下面，不重复一遍。
    expect(screen.getByText('改完要重启。')).toBeInTheDocument()
    expect(
      screen.queryByText('要不要开 MiniMax Code 这个上游。改完要重启。')
    ).not.toBeInTheDocument()
  })

  it('label 和 description 都没有时才退回键名', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'MYSTERY_KEY',
              label: '',
              value: '1',
              source: 'default',
              fallback: '1',
              group: 'general',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('MYSTERY_KEY')
  })
})
