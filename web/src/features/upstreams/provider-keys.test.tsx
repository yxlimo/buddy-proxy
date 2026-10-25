import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListUpstreamsResponseSchema,
  SetProviderKeysResponseSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { upstreamKeys } from '@/features/upstreams/api'
import { mockAdminClient } from '@/test/mock-transport'
import { makeTestQueryClient, renderWithClient } from '@/test/render'

/**
 * 填 key 写到它自己的上游上。
 *
 * 上游 id 是用户起的，minimax-api 只是这一类的默认 id。所以找不到上游的
 * 时候不能拿别的上游顶上去：key 写错了地方比写不进去更麻烦。
 */
describe('上游的 API Key', () => {
  it('key 写到点它的那一行，不写到别的上游上', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []

    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'my-minimax',
              label: '我的开放平台',
              kind: 'minimax-api',
              enabled: true,
            }),
          ],
        }),
      ListAccounts: () =>
        create(ListAccountsResponseSchema, {
          accounts: [
            create(AccountSchema, {
              id: 'my-minimax:1',
              upstreamId: 'my-minimax',
              label: '租户一',
              status: 'missing',
            }),
          ],
        }),
      ListCredentials: () => create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        sent.push(input.upstreamId ?? '')
        return create(SetProviderKeysResponseSchema, { ok: true, message: '写好了' })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    // 展开那一行，账号与凭据在里面。
    await user.click(
      await screen.findByRole('button', {
        name: /展开 my-minimax 的账号与凭据/,
      })
    )
    await user.click(await screen.findByRole('button', { name: 'API Key' }))

    await user.type(
      await screen.findByLabelText('key（每行一把）'),
      'sk-tenant-one'
    )
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['my-minimax'])
    })
    // 没有落到 minimax-api 上去。
    expect(sent).not.toContain('minimax-api')
  })

  it('上游从列表里没了：弹窗关掉，不把 key 写到别的上游上', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    let upstreamGone = false

    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: upstreamGone
            ? []
            : [
                create(UpstreamSchema, {
                  id: 'my-minimax',
                  label: '我的开放平台',
                  kind: 'minimax-api',
                  enabled: true,
                }),
              ],
        }),
      ListAccounts: () =>
        create(ListAccountsResponseSchema, {
          accounts: [
            create(AccountSchema, {
              id: 'my-minimax:1',
              upstreamId: 'my-minimax',
              label: '租户一',
              status: 'missing',
            }),
          ],
        }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        sent.push(input.upstreamId ?? '')
        return create(SetProviderKeysResponseSchema, {
          ok: true,
          message: '写好了',
        })
      },
    })

    const queryClient = makeTestQueryClient()
    renderWithClient({
      client,
      queryClient,
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', {
        name: /展开 my-minimax 的账号与凭据/,
      })
    )
    await user.click(await screen.findByRole('button', { name: 'API Key' }))
    await screen.findByRole('dialog')

    // 上游没了：重取列表之后它不在了。
    upstreamGone = true
    await queryClient.invalidateQueries({ queryKey: upstreamKeys.all })

    // 弹窗跟着关掉，不留着让人往别处写 key。
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(sent).toEqual([])
  })
})
