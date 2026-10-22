import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ConfigItemSchema,
  ListConfigResponseSchema,
  SetConfigResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { ConfigPage } from '@/features/config/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 敏感项只写不读：服务端回的是掩码。
 *
 * 掩码长得太像值了 —— 把它当输入回传，库里就会写进一个叫 "***" 的密钥，
 * 重启后 parseBool 认不出来，门就开了。这组用例盯的就是「掩码不许被
 * 当值发出去」。
 */
describe('配置页的敏感项', () => {
  it('输入框里是空的，保存时不发请求', async () => {
    const user = userEvent.setup()
    const sent: string[] = []

    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              value: '***',
              source: 'database',
              fallback: 'false',
              group: '上游开关',
              secret: true,
              hasValue: true,
            }),
          ],
        }),
      SetConfig: (input) => {
        sent.push(input.value ?? '')
        return create(SetConfigResponseSchema, { ok: true, message: '写了' })
      },
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('REQUIRE_API_KEY')

    // 界面上不说掩码，只说有没有值。
    expect(screen.getByText('已设置')).toBeInTheDocument()
    expect(screen.queryByText('***')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '改' }))

    const input = screen.getByLabelText('新值') as HTMLInputElement
    expect(input.value).toBe('')
    expect(screen.getByText(/留空表示不改/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))

    // 什么都没填：连请求都不该发（空串会被服务端当成「把密钥清空」）。
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(sent).toEqual([])
  })

  it('填了新值才发请求，发出去的是新值', async () => {
    const user = userEvent.setup()
    const sent: string[] = []

    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              value: '***',
              source: 'database',
              fallback: 'false',
              group: '上游开关',
              secret: true,
              hasValue: true,
            }),
          ],
        }),
      SetConfig: (input) => {
        sent.push(input.value ?? '')
        return create(SetConfigResponseSchema, { ok: true, message: '写了' })
      },
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('REQUIRE_API_KEY')
    await user.click(screen.getByRole('button', { name: '改' }))

    const input = screen.getByLabelText('新值') as HTMLInputElement
    await user.type(input, 'sk-new-value')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['sk-new-value'])
    })
    expect(sent).not.toContain('***')
  })

  it('服务端回 ok:false 的时候报失败，不当成功', async () => {
    const user = userEvent.setup()

    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              value: '',
              source: 'environment',
              fallback: 'false',
              group: '上游开关',
              secret: true,
            }),
          ],
        }),
      SetConfig: () =>
        create(SetConfigResponseSchema, {
          ok: false,
          message: '不认识的配置项：REQUIRE_API_KEY',
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('REQUIRE_API_KEY')
    await user.click(screen.getByRole('button', { name: '改' }))
    await user.type(screen.getByLabelText('新值'), 'sk-new-value')
    await user.click(screen.getByRole('button', { name: '保存' }))

    // 失败时弹窗留着，用户填的东西还在。
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
  })

  it('默认值只在和当前值不一样的时候露出来', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'A_OVERRIDDEN',
              value: 'true',
              source: 'database',
              fallback: 'false',
              group: '上游开关',
            }),
            create(ConfigItemSchema, {
              key: 'B_PLAIN',
              value: '30000',
              source: 'environment',
              fallback: '30000',
              group: '上游开关',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('A_OVERRIDDEN')
    expect(screen.getByText('默认值 false')).toBeInTheDocument()
    // 值和默认值一样的时候不用再重复一遍。
    expect(screen.queryByText('默认值 30000')).not.toBeInTheDocument()
  })
})
