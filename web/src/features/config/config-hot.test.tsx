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
 * 面板能改的那些设置改完立刻生效。
 *
 * 所以界面上不再提「重启后生效」：pending_restart 只对服务内部的设置为真，
 * 那些设置面板看不见。
 */
describe('配置页不用再提重启', () => {
  it('页面上没有「重启后生效」这类话', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          // pending_restart 为真也不提：面板能改的那些是热的。
          pendingRestart: true,
          items: [
            create(ConfigItemSchema, {
              key: 'MINIMAX_CODE',
              label: 'MiniMax Code 上游',
              value: 'true',
              source: 'environment',
              fallback: 'false',
              group: 'general',
              description: '要不要开 MiniMax Code 这个上游。',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('MiniMax Code 上游')
    expect(screen.queryByText(/重启后生效/)).not.toBeInTheDocument()
    expect(screen.queryByText(/重启网关/)).not.toBeInTheDocument()
    expect(screen.queryByText(/待重启/)).not.toBeInTheDocument()
    // 改完立刻生效，这句话要留着。
    expect(screen.getAllByText(/改完立刻生效/).length).toBeGreaterThan(0)
  })
})
