import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  SetProviderKeysResponseSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { Account } from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { upstreamKeys } from '@/features/upstreams/api'
import { mockAdminClient } from '@/test/mock-transport'
import { makeTestQueryClient, renderWithClient } from '@/test/render'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: toastSuccess,
  }),
  Toaster: () => null,
}))

/** 一个开放平台的账号。 */
function account(): Account {
  return create(AccountSchema, {
    id: 'minimax-api',
    platform: 'minimax-api',
    alias: '租户一',
    enabled: true,
    status: 'missing',
    credentialCount: 0,
  })
}

/**
 * key 挂在账号上。
 *
 * 一个账号一份 key：点了哪一个账号的「API Key」，就写到那个账号上，不写到别处
 * 去。
 */
describe('账号的 API Key', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('key 写到点它的那个账号上', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []

    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax-api',
              kind: 'minimax-api',
              label: 'MiniMax 开放平台',
              state: UpstreamState.NO_CREDENTIAL,
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 1,
              accounts: [account()],
            }),
          ],
        }),
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [account()] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        sent.push(input.upstreamId ?? '')
        return create(SetProviderKeysResponseSchema, {
          ok: true,
          message: '写好了',
          count: 1,
        })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    // 展开那一行，账号在里面。
    await user.click(
      await screen.findByRole('button', {
        name: '展开 minimax-api 的账号与凭据',
      })
    )
    await user.click(await screen.findByRole('button', { name: 'API Key' }))

    await user.type(
      await screen.findByLabelText('key（每行一把）'),
      'sk-tenant-one'
    )
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['minimax-api'])
    })
  })

  it('key 是写到账号 id 上的，不是平台 id', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []

    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax-api',
              kind: 'minimax-api',
              label: 'MiniMax 开放平台',
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 2,
              accounts: [
                account(),
                create(AccountSchema, {
                  id: 'minimax-api-2',
                  platform: 'minimax-api',
                  alias: '租户二',
                  enabled: true,
                  status: 'missing',
                  credentialCount: 0,
                }),
              ],
            }),
          ],
        }),
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        sent.push(input.upstreamId ?? '')
        return create(SetProviderKeysResponseSchema, { ok: true })
      },
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', {
        name: '展开 minimax-api 的账号与凭据',
      })
    )

    // 两个账号各有一个「API Key」按钮：点第二个账号那一行的。
    const row = (await screen.findByText('租户二')).closest('tr')
    await user.click(
      within(row as HTMLElement).getByRole('button', { name: 'API Key' })
    )
    await user.type(
      await screen.findByLabelText('key（每行一把）'),
      'sk-tenant-two'
    )
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual(['minimax-api-2'])
    })
  })

  it('账号从列表里没了：弹窗关掉，不把 key 写到别处去', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    let gone = false

    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax-api',
              kind: 'minimax-api',
              label: 'MiniMax 开放平台',
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: gone ? 0 : 1,
              accounts: gone ? [] : [account()],
            }),
          ],
        }),
      ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        sent.push(input.upstreamId ?? '')
        return create(SetProviderKeysResponseSchema, { ok: true })
      },
    })

    const queryClient = makeTestQueryClient()
    renderWithClient({ client, queryClient, children: <UpstreamsPage /> })

    await user.click(
      await screen.findByRole('button', {
        name: '展开 minimax-api 的账号与凭据',
      })
    )
    await user.click(await screen.findByRole('button', { name: 'API Key' }))
    await screen.findByRole('dialog')

    // 账号没了：重取列表之后它不在了。
    gone = true
    await queryClient.invalidateQueries({ queryKey: upstreamKeys.all })

    // 弹窗跟着关掉，不留着让人往别处写 key。
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(sent).toEqual([])
  })
})

/** 七牛云的账号：一段推理 key 加一段门户 cookie。 */
function qiniuAccount(): Account {
  return create(AccountSchema, {
    id: 'qiniu-1',
    platform: 'qiniu',
    alias: '七牛一',
    enabled: true,
    status: 'missing',
    credentialCount: 0,
  })
}

/**
 * 七牛云要两段凭据：推理 API Key 与门户 cookie。
 *
 * 两段各有位置：哪一段留空就是清掉哪一段，所以空串也要传上去，不能滤掉。
 */
describe('七牛云的凭据', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  /** 只列一个七牛云上游，把每次提交的两段记下来。 */
  function qiniuClient(sent: string[][]) {
    return mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'qiniu',
              kind: 'qiniu',
              label: '七牛云',
              state: UpstreamState.NO_CREDENTIAL,
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 1,
              accounts: [qiniuAccount()],
            }),
          ],
        }),
      ListAccounts: () =>
        create(ListAccountsResponseSchema, { accounts: [qiniuAccount()] }),
      ListCredentials: () =>
        create(ListCredentialsResponseSchema, { credentials: [] }),
      SetProviderKeys: (input) => {
        const keys = input.keys ?? []
        sent.push(keys)
        return create(SetProviderKeysResponseSchema, {
          ok: true,
          message: '写好了',
          count: keys.length,
        })
      },
    })
  }

  it('点「凭据」打开的是两个输入框的弹窗', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: qiniuClient(sent),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 qiniu 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByLabelText('推理 API Key')).toBeInTheDocument()
    expect(await screen.findByLabelText('门户 Cookie')).toBeInTheDocument()
  })

  it('只填门户 cookie：推理 key 留空也要占着位置', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: qiniuClient(sent),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 qiniu 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    await user.type(await screen.findByLabelText('门户 Cookie'), 'c=1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['', 'c=1']])
    })
  })

  it('两段都填：推理 key 在前，门户 cookie 在后', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: qiniuClient(sent),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 qiniu 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    await user.type(await screen.findByLabelText('推理 API Key'), 'k1')
    await user.type(await screen.findByLabelText('门户 Cookie'), 'c=1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['k1', 'c=1']])
    })
  })

  it('两段都空：两段都传空串上去，清不清理由后端决定', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []

    renderWithClient({
      client: qiniuClient(sent),
      children: <UpstreamsPage />,
    })

    await user.click(
      await screen.findByRole('button', { name: '展开 qiniu 的账号与凭据' })
    )
    await user.click(await screen.findByRole('button', { name: '凭据' }))

    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['', '']])
    })
  })
})
