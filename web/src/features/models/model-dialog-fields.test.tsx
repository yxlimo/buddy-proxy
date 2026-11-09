import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CatalogModelSchema,
  CredentialState,
  CredentialStatusSchema,
  ListModelsResponseSchema,
  ListUpstreamsResponseSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import { ModelDialog } from '@/features/models/model-dialog'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 一个开着的、已登录的上游。 */
function usableUpstream(id: string, label: string) {
  return create(UpstreamSchema, {
    id,
    label,
    enabled: true,
    state: UpstreamState.READY,
    modelCount: 2,
    credential: create(CredentialStatusSchema, {
      status: CredentialState.AUTHENTICATED,
      kind: 'session',
    }),
  })
}

function catalogClient() {
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [usableUpstream('qoder', 'Qoder 全球区')],
      }),
    ListModels: () =>
      create(ListModelsResponseSchema, {
        models: [
          create(CatalogModelSchema, {
            id: 'claude-sonnet-4',
            displayName: 'Claude Sonnet 4',
            contextWindow: 200000,
          }),
          create(CatalogModelSchema, {
            id: 'claude-opus-4',
            displayName: 'Claude Opus 4',
            contextWindow: 200000,
          }),
        ],
      }),
  })
}

/** 在下拉里选一个上游组。 */
async function pickGroup(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  const trigger = await screen.findByRole('combobox', { name: '平台组' })
  await waitFor(() => {
    expect(trigger).toBeEnabled()
  })
  await user.click(trigger)
  await user.click(await screen.findByRole('option', { name }))
}

describe('模型编辑弹窗', () => {
  it('必填项没填的时候，所在的分组标题上标红', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    // 一开始两个分组都有没填的必填项。
    const basicTab = screen.getByRole('tab', { name: /基本/ })
    const targetsTab = screen.getByRole('tab', { name: /平台目标/ })
    expect(basicTab.querySelector('.bg-destructive')).not.toBeNull()
    expect(targetsTab.querySelector('.bg-destructive')).not.toBeNull()

    // 基本那个分组：对外 id 没填，行内有提示。
    expect(screen.getByText(/对外 id 是必填的/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('对外 id'), 'buddy-max')
    // 填了之后基本那个分组就不标红了。
    await waitFor(() => {
      expect(basicTab.querySelector('.bg-destructive')).toBeNull()
    })
  })

  it('切到有问题的分组，给行内提示', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))

    expect(
      screen.getByText('至少要有一个填全的目标：平台组和平台模型 id 都要填。')
    ).toBeInTheDocument()
  })

  it('选了平台组之后，平台模型 id 变成目录里的下拉', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))

    // 还没选组：没有目录，输入框手填。
    expect(screen.getByText(/先选平台组/)).toBeInTheDocument()

    await pickGroup(user, /Qoder 全球区/)

    // 目录拉回来之后变成下拉。
    const picker = await screen.findByRole('combobox', {
      name: '平台模型 id',
    })
    await user.click(picker)

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('claude-sonnet-4')).toBeInTheDocument()
    expect(within(listbox).getByText('claude-opus-4')).toBeInTheDocument()
  })

  it('目录拉不到的时候退回手填，并且说清楚为什么', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [usableUpstream('minimax', 'MiniMax Code')],
        }),
      ListModels: () => create(ListModelsResponseSchema, { models: [] }),
    })

    renderWithClient({
      client,
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    await pickGroup(user, /MiniMax Code/)

    await waitFor(() => {
      expect(
        screen.getByText('这个平台没有目录，手填模型 id。')
      ).toBeInTheDocument()
    })
    // 手填的输入框在。
    expect(screen.getByLabelText('平台模型 id')).toBeInTheDocument()
  })

  it('single 策略下没有权重输入框，fallback 才有', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    // 默认是 single：权重没意义，整块不画。
    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    expect(screen.queryByLabelText('权重')).not.toBeInTheDocument()
    expect(
      screen.queryByText('权重大的先试，失败了才试小的。')
    ).not.toBeInTheDocument()

    // 策略在「基本」那一页：切成 fallback。
    await user.click(screen.getByRole('tab', { name: /^基本/ }))
    await user.click(screen.getByRole('combobox', { name: '策略' }))
    await user.click(await screen.findByRole('option', { name: /fallback/ }))

    // 再回到「上游目标」，权重就出来了。
    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    expect(screen.getByLabelText('权重')).toBeInTheDocument()
    expect(screen.getByText('权重大的先试，失败了才试小的。')).toBeInTheDocument()
  })

  it('上下文填 1.5：那一格行内说清，保存灰着', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog
          open
          onOpenChange={() => {}}
          onSubmit={(model) => submitted.push(model)}
        />
      ),
    })

    // 先摆成一份能过的：对外 id 加上一个填全的目标。
    await user.type(screen.getByLabelText('对外 id'), 'buddy-max')
    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    await pickGroup(user, /Qoder 全球区/)
    await user.click(
      await screen.findByRole('combobox', { name: '平台模型 id' })
    )
    const listbox = await screen.findByRole('listbox')
    await user.click(within(listbox).getByText('claude-sonnet-4'))
    await user.click(screen.getByRole('tab', { name: /^基本/ }))

    const save = screen.getByRole('button', { name: '保存' })
    await waitFor(() => {
      expect(save).toBeEnabled()
    })

    // 继承平台时那两格灰着：值不属于这一单，不判。要判就先关掉继承。
    const [contextInherit] = screen.getAllByLabelText('继承平台')
    await user.click(contextInherit)
    const context = screen.getByLabelText('上下文长度')
    await waitFor(() => {
      expect(context).toBeEnabled()
    })

    await user.type(context, '1.5')
    // 服务端只会回「不是整数」（MODEL_NUMBER_INVALID）：这一句在按保存前就有。
    expect(screen.getByText('要填整数')).toBeInTheDocument()
    expect(context).toHaveAttribute('aria-invalid', 'true')
    expect(save).toBeDisabled()

    // 判别力所在：点下去也不交东西。
    await user.click(save)
    expect(submitted).toEqual([])

    await user.clear(context)
    await user.type(context, '-1')
    expect(screen.getByText('不能是负数')).toBeInTheDocument()
    expect(save).toBeDisabled()

    await user.clear(context)
    await user.type(context, '200000')
    await waitFor(() => {
      expect(save).toBeEnabled()
    })
    expect(screen.queryByText('要填整数')).not.toBeInTheDocument()
    expect(screen.queryByText('不能是负数')).not.toBeInTheDocument()
  })

  it('没有「顺序」那个输入框', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))

    expect(screen.queryByLabelText('顺序')).not.toBeInTheDocument()
  })
})
