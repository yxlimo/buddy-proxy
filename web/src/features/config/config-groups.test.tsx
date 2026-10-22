import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ConfigItemSchema,
  ListConfigResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { ConfigPage } from '@/features/config/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

function item(
  key: string,
  group: string,
  label: string,
  extra: Partial<{ value: string; source: string }> = {}
) {
  return create(ConfigItemSchema, {
    key,
    group,
    label,
    value: 'true',
    source: 'environment',
    fallback: 'false',
    description: '',
    secret: false,
    hasValue: true,
    ...extra,
  })
}

/**
 * 配置页按分组切成 tab。
 *
 * 服务端现在只公布用户能改的那几项（各个上游的开关 + 网关自己的两个），
 * 内部设置不再公布。
 */
describe('配置页的分组', () => {
  it('每个分组一个 tab，名字是中文的', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            item('ADMIN_CORS_ORIGINS', 'general', '允许的跨域来源'),
            item('REQUIRE_API_KEY', 'gateway', '前门要 API key'),
            item('MINIMAX_CODE', 'minimax', 'MiniMax Code 上游'),
            item('QODER_GLOBAL', 'qoder', 'Qoder 全球区'),
            item('QODER_CN', 'qoder', 'Qoder 中国区'),
            item('WORKBUDDY_CN', 'workbuddy', 'WorkBuddy 中国区'),
            item('TOKENRHYTHM', 'tokenrhythm', 'TokenRhythm 上游'),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByRole('tab', { name: /常规/ })
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)

    expect(tabs).toEqual([
      '常规(1)',
      '网关(1)',
      'MiniMax(1)',
      'Qoder(2)',
      'WorkBuddy(1)',
      'TokenRhythm(1)',
    ])
    // tab 上写的是中文，不是英文的分组键。
    expect(tabs.join()).not.toContain('minimax')
    expect(tabs.join()).not.toContain('tokenrhythm')
  })

  it('打开时停在「常规」那一组', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            item('ADMIN_CORS_ORIGINS', 'general', '允许的跨域来源'),
            item('MINIMAX_CODE', 'minimax', 'MiniMax Code 上游'),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    const general = await screen.findByRole('tab', { name: /常规/ })
    expect(general).toHaveAttribute('aria-selected', 'true')
    // 常规那一组的内容在页面上。
    expect(screen.getByText('允许的跨域来源')).toBeInTheDocument()
    // 别的组的内容不在。
    expect(screen.queryByText('MiniMax Code 上游')).not.toBeInTheDocument()
  })

  it('「常规」那一组是空的时，tab 也在，打开时停在这儿，并给空状态', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [item('MINIMAX_CODE', 'minimax', 'MiniMax Code 上游')],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    const general = await screen.findByRole('tab', { name: /常规/ })
    expect(general).toHaveAttribute('aria-selected', 'true')
    expect(general.textContent).toBe('常规(0)')
    expect(screen.getByText('这一组暂时没有可改的设置')).toBeInTheDocument()
  })

  it('切到别的组，那一组的设置就出来了', async () => {
    const user = userEvent.setup()
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            item('ADMIN_CORS_ORIGINS', 'general', '允许的跨域来源'),
            item('QODER_GLOBAL', 'qoder', 'Qoder 全球区'),
            item('QODER_CN', 'qoder', 'Qoder 中国区'),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    const qoder = await screen.findByRole('tab', { name: /Qoder/ })
    await user.click(qoder)

    expect(screen.getByText('Qoder 全球区')).toBeInTheDocument()
    expect(screen.getByText('Qoder 中国区')).toBeInTheDocument()
    expect(screen.queryByText('允许的跨域来源')).not.toBeInTheDocument()
  })

  it('认不出来的分组原样显示，不猜', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [item('SOMETHING_NEW', 'weird-group', '某个新设置')],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    const tab = await screen.findByRole('tab', { name: /weird-group/ })
    expect(within(tab).getByText('(1)')).toBeInTheDocument()
  })
})
