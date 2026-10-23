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
 * 服务端公布什么就画什么：上游的开关搬去「上游」页之后，配置页剩下的多半
 * 只有网关自己的设置。空的组不画。
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

  it('空的组不画：没有设置项的组连 tab 都没有', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [item('MINIMAX_CODE', 'minimax', 'MiniMax Code 上游')],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByRole('tab', { name: /MiniMax/ })
    // 「常规」这一组是空的：不画 tab，也不给空状态。
    expect(screen.queryByRole('tab', { name: /常规/ })).not.toBeInTheDocument()
    expect(
      screen.queryByText('这一组暂时没有可改的设置')
    ).not.toBeInTheDocument()
  })

  it('只有网关自己的设置时也照常显示', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [item('REQUIRE_API_KEY', 'gateway', '前门要 API key')],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    const gateway = await screen.findByRole('tab', { name: /网关/ })
    expect(gateway).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('前门要 API key')).toBeInTheDocument()
  })

  it('一项都没有的时候给空状态', async () => {
    const client = mockAdminClient({
      ListConfig: () => create(ListConfigResponseSchema, { items: [] }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    expect(
      await screen.findByText('网关没有报任何配置项')
    ).toBeInTheDocument()
  })

  it('切到别的组，那一组的设置就出来了', async () => {
    const user = userEvent.setup({ delay: null })
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
