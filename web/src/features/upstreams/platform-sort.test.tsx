import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListPlatformKindsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListUpstreamsResponseSchema,
  PlatformKindSchema,
  ProviderPolicy,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { PLATFORM_ORDER_KEY } from '@/lib/platform-order'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 一个平台：表里有行，账下有一个账号。 */
function platform(
  id: string,
  label: string,
  overrides: Partial<MessageInitShape<typeof UpstreamSchema>> = {}
) {
  const base: MessageInitShape<typeof UpstreamSchema> = {
    id,
    kind: 'minimax',
    label,
    region: 'cn',
    state: UpstreamState.READY,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: 1,
    hasEnabledAccount: true,
    fromRow: true,
    accounts: [
      create(AccountSchema, {
        id,
        platform: id,
        alias: '主账号',
        enabled: true,
        status: 'usable',
        credentialCount: 1,
      }),
    ],
  }
  return create(UpstreamSchema, Object.assign(base, overrides))
}

/** 一家平台的清单：三家的次序照服务端那一份（alpha、beta、gamma）。 */
function platforms(): Upstream[] {
  return [
    platform('alpha', 'Alpha 平台'),
    platform('beta', 'Beta 平台'),
    platform('gamma', 'Gamma 平台'),
  ]
}

function clientWith(upstreams: Upstream[]) {
  return mockAdminClient({
    ListUpstreams: () => create(ListUpstreamsResponseSchema, { upstreams }),
    ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
    ListCredentials: () =>
      create(ListCredentialsResponseSchema, { credentials: [] }),
    ListPublishedModels: () =>
      create(ListPublishedModelsResponseSchema, { models: [] }),
    ListPlatformKinds: () =>
      create(ListPlatformKindsResponseSchema, {
        kinds: [create(PlatformKindSchema, { kind: 'minimax', label: 'MiniMax Code', presetId: 'minimax', category: 'simulated' })],
      }),
  })
}

/** 拖拽事件里那份搬运工：jsdom 没有 DataTransfer，凑一个够用的。 */
function dataTransfer() {
  return { setData: () => {}, getData: () => '', effectAllowed: '', dropEffect: '' }
}

/** 排序列表里各行平台的 id，按界面上的次序。 */
function listedIds(): string[] {
  const list = screen.getByRole('list', { name: '平台排序' })
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('data-platform-id') ?? '')
}

/** 表格里各行平台的 id，按界面上的次序。 */
function tableIds(): string[] {
  return screen
    .getAllByText(/^(alpha|beta|gamma)$/)
    .map((node) => node.textContent ?? '')
}

/** 存下来的次序。 */
function storedOrder(): string[] {
  const raw = window.localStorage.getItem(PLATFORM_ORDER_KEY)
  return raw === null ? [] : (JSON.parse(raw) as string[])
}

beforeEach(() => {
  window.localStorage.removeItem(PLATFORM_ORDER_KEY)
  window.history.replaceState(null, '', '/')
})

describe('平台页的排序模式', () => {
  it('点「排序」进排序模式：行换成能拖的列表，按钮变成「完成排序」', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: clientWith(platforms()), children: <UpstreamsPage /> })

    await screen.findByText('Alpha 平台')
    // 没进排序模式时是表格，行不是能拖的东西。
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '平台排序' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '排序' }))

    expect(await screen.findByRole('list', { name: '平台排序' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完成排序' })).toBeInTheDocument()
    // 次序先照服务端那一份。
    expect(listedIds()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('排序模式下点行不展开：行上没有展开按钮', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: clientWith(platforms()), children: <UpstreamsPage /> })

    await screen.findByText('Alpha 平台')
    await user.click(screen.getByRole('button', { name: '排序' }))

    await screen.findByRole('list', { name: '平台排序' })
    expect(
      screen.queryByRole('button', { name: '展开 alpha 的账号与凭据' })
    ).not.toBeInTheDocument()
  })

  it('「下移」把下一家挪到前面来，次序存进浏览器', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: clientWith(platforms()), children: <UpstreamsPage /> })

    await screen.findByText('Alpha 平台')
    await user.click(screen.getByRole('button', { name: '排序' }))
    await screen.findByRole('list', { name: '平台排序' })

    await user.click(screen.getByRole('button', { name: '下移 alpha' }))

    expect(listedIds()).toEqual(['beta', 'alpha', 'gamma'])
    expect(storedOrder()).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('「上移」把上一家挪到后面去，次序存进浏览器', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: clientWith(platforms()), children: <UpstreamsPage /> })

    await screen.findByText('Alpha 平台')
    await user.click(screen.getByRole('button', { name: '排序' }))
    await screen.findByRole('list', { name: '平台排序' })

    await user.click(screen.getByRole('button', { name: '上移 gamma' }))

    expect(listedIds()).toEqual(['alpha', 'gamma', 'beta'])
    expect(storedOrder()).toEqual(['alpha', 'gamma', 'beta'])
  })

  it('拖动一行放到另一行上：次序跟着换，并存进浏览器', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: clientWith(platforms()), children: <UpstreamsPage /> })

    await screen.findByText('Alpha 平台')
    await user.click(screen.getByRole('button', { name: '排序' }))
    const list = await screen.findByRole('list', { name: '平台排序' })
    const items = within(list).getAllByRole('listitem')
    const transfer = dataTransfer()

    fireEvent.dragStart(items[0], { dataTransfer: transfer })
    fireEvent.dragOver(items[2], { dataTransfer: transfer })
    fireEvent.drop(items[2], { dataTransfer: transfer })

    expect(listedIds()).toEqual(['beta', 'gamma', 'alpha'])
    expect(storedOrder()).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('退出排序模式：回到表格，点行又能展开', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: clientWith(platforms()), children: <UpstreamsPage /> })

    await screen.findByText('Alpha 平台')
    await user.click(screen.getByRole('button', { name: '排序' }))
    await screen.findByRole('list', { name: '平台排序' })

    await user.click(screen.getByRole('button', { name: '完成排序' }))

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '平台排序' })).not.toBeInTheDocument()

    await user.click(screen.getByText('Alpha 平台'))

    expect(
      await screen.findByRole('button', { name: '收起 alpha 的账号与凭据' })
    ).toBeInTheDocument()
  })
})

describe('表格的行次序', () => {
  it('照存下来的次序排，与服务端次序无关', async () => {
    window.localStorage.setItem(
      PLATFORM_ORDER_KEY,
      JSON.stringify(['gamma', 'alpha', 'beta'])
    )

    renderWithClient({ client: clientWith(platforms()), children: <UpstreamsPage /> })

    await screen.findByText('Gamma 平台')
    expect(tableIds()).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('次序里多出来的平台丢掉，新出现的排在后面', async () => {
    window.localStorage.setItem(
      PLATFORM_ORDER_KEY,
      JSON.stringify(['gone', 'gamma'])
    )

    renderWithClient({ client: clientWith(platforms()), children: <UpstreamsPage /> })

    await screen.findByText('Gamma 平台')
    expect(tableIds()).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('没存过次序时照服务端次序', async () => {
    renderWithClient({ client: clientWith(platforms()), children: <UpstreamsPage /> })

    await screen.findByText('Alpha 平台')
    expect(tableIds()).toEqual(['alpha', 'beta', 'gamma'])
    expect(storedOrder()).toEqual([])
  })
})
