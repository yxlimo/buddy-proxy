import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CatalogModelSchema,
  CredentialState,
  CredentialStatusSchema,
  ListModelsResponseSchema,
  ListUpstreamsResponseSchema,
  PublishedModelSchema,
  PublishedTargetSchema,
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

/**
 * 两个平台，模型目录里有对方的同名模型：
 *
 * - tokenrhythm：glm-5.3-flash、neohorse-1-9b
 * - workbuddy-cn：glm-5.3-flash、glm-5.3-air
 *
 * 这样「同平台不同模型」和「不同平台同一模型」都摆得出来。
 */
function twoPlatformClient() {
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [
          usableUpstream('tokenrhythm', 'TokenRhythm'),
          usableUpstream('workbuddy-cn', 'WorkBuddy 国内区'),
        ],
      }),
    ListModels: (input) =>
      create(ListModelsResponseSchema, {
        models: (
          input.upstreamId === 'workbuddy-cn'
            ? ['glm-5.3-flash', 'glm-5.3-air']
            : ['glm-5.3-flash', 'neohorse-1-9b']
        ).map((id) => create(CatalogModelSchema, { id, displayName: id })),
      }),
  })
}

/** 在下拉里选一个平台组。index 是第几个目标行（从 0 数）。 */
async function pickGroup(
  user: ReturnType<typeof userEvent.setup>,
  index: number,
  name: RegExp
) {
  const triggers = await screen.findAllByRole('combobox', { name: '平台组' })
  await waitFor(() => {
    expect(triggers[index]).toBeEnabled()
  })
  await user.click(triggers[index])
  await user.click(await screen.findByRole('option', { name }))
}

/** 在某一行里从目录选一个上游模型。 */
async function pickModel(
  user: ReturnType<typeof userEvent.setup>,
  index: number,
  modelId: string
) {
  const triggers = await screen.findAllByRole('combobox', {
    name: '平台模型 id',
  })
  await user.click(triggers[index])
  await user.click(await screen.findByRole('option', { name: modelId }))
}

/** 打开某一行的模型下拉，返回那一行的选项。 */
async function openModelOptions(
  user: ReturnType<typeof userEvent.setup>,
  index: number
) {
  const triggers = await screen.findAllByRole('combobox', {
    name: '平台模型 id',
  })
  await user.click(triggers[index])
  const listbox = await screen.findByRole('listbox')
  await waitFor(() => {
    expect(within(listbox).getAllByRole('option').length).toBeGreaterThan(0)
  })
  return within(listbox).getAllByRole('option')
}

/** 一个两行都填 tokenrhythm / glm-5.3-flash 的模型：后端给的畸形数据。 */
function duplicatedModel() {
  const target = () =>
    create(PublishedTargetSchema, {
      groupName: 'tokenrhythm',
      upstreamModel: 'glm-5.3-flash',
      weight: 1,
      enabled: true,
    })
  return create(PublishedModelSchema, {
    id: 'buddy-max',
    displayName: 'buddy-max',
    enabled: true,
    strategy: 'single',
    targets: [target(), target()],
  })
}

describe('同一个 (平台, 上游模型) 组合不能挂两行', () => {
  it('组合重复的时候，行内说清是哪一行撞了，保存灰着也不发请求', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    renderWithClient({
      client: twoPlatformClient(),
      children: (
        <ModelDialog
          open
          model={duplicatedModel()}
          onOpenChange={() => {}}
          onSubmit={(model) => submitted.push(model)}
        />
      ),
    })

    const save = screen.getByRole('button', { name: '保存' })
    // 别的都填全了，唯一的问题是组合重复。
    await waitFor(() => {
      expect(save).toBeDisabled()
    })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    // 行内点名是哪一组、和上面第几行撞了。
    expect(
      screen.getByText(/tokenrhythm \/ glm-5\.3-flash 已经有一行了/)
    ).toBeInTheDocument()
    expect(screen.getByText(/第 1 个目标/)).toBeInTheDocument()

    // 判别力所在：点下去也不交东西。
    await user.click(save)
    expect(submitted).toEqual([])
  })

  it('别的行用掉的组合在下拉里置灰，并说明为什么选不了', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({
      client: twoPlatformClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    await user.type(screen.getByLabelText('对外 id'), 'buddy-max')
    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    await pickGroup(user, 0, /TokenRhythm/)
    await pickModel(user, 0, 'glm-5.3-flash')

    await user.click(screen.getByRole('button', { name: '加一个目标' }))
    await pickGroup(user, 1, /TokenRhythm/)

    const options = await openModelOptions(user, 1)
    const taken = options.find((option) =>
      option.textContent?.includes('glm-5.3-flash')
    )
    const free = options.find((option) =>
      option.textContent?.includes('neohorse-1-9b')
    )

    // 同一个平台 + 同一个模型：选不了，并说清「已经有一行」。
    expect(taken).toHaveAttribute('aria-disabled', 'true')
    expect(taken).toHaveTextContent('已经有一行')
    // 同一个平台、另一个模型：照选，不置灰。
    expect(free).not.toHaveAttribute('aria-disabled', 'true')

    // 点它也不落值（pointer-events 挡着，这里直接派发点击）。
    fireEvent.click(taken as HTMLElement)

    const triggers = await screen.findAllByRole('combobox', {
      name: '平台模型 id',
    })
    expect(triggers[1]).toHaveTextContent('选一个平台模型')
    // 既然没落值，就没有重复，第二行只是「还没填全」。
    expect(
      screen.queryByText(/已经有一行了/)
    ).not.toBeInTheDocument()
  })

  it('同一个平台上两个不同的上游模型：可以保存，也没有错误', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    renderWithClient({
      client: twoPlatformClient(),
      children: (
        <ModelDialog
          open
          onOpenChange={() => {}}
          onSubmit={(model) => submitted.push(model)}
        />
      ),
    })

    await user.type(screen.getByLabelText('对外 id'), 'buddy-max')
    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    await pickGroup(user, 0, /TokenRhythm/)
    await pickModel(user, 0, 'glm-5.3-flash')
    await user.click(screen.getByRole('button', { name: '加一个目标' }))
    await pickGroup(user, 1, /TokenRhythm/)
    await pickModel(user, 1, 'neohorse-1-9b')

    const save = screen.getByRole('button', { name: '保存' })
    await waitFor(() => {
      expect(save).toBeEnabled()
    })
    expect(screen.queryByText(/已经有一行了/)).not.toBeInTheDocument()

    await user.click(save)
    expect(submitted).toHaveLength(1)
  })

  it('两个平台挂同一个上游模型：可以保存，也没有错误', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    renderWithClient({
      client: twoPlatformClient(),
      children: (
        <ModelDialog
          open
          onOpenChange={() => {}}
          onSubmit={(model) => submitted.push(model)}
        />
      ),
    })

    await user.type(screen.getByLabelText('对外 id'), 'buddy-max')
    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    await pickGroup(user, 0, /TokenRhythm/)
    await pickModel(user, 0, 'glm-5.3-flash')
    await user.click(screen.getByRole('button', { name: '加一个目标' }))
    await pickGroup(user, 1, /WorkBuddy 国内区/)
    await pickModel(user, 1, 'glm-5.3-flash')

    const save = screen.getByRole('button', { name: '保存' })
    await waitFor(() => {
      expect(save).toBeEnabled()
    })
    expect(screen.queryByText(/已经有一行了/)).not.toBeInTheDocument()

    await user.click(save)
    expect(submitted).toHaveLength(1)
  })

  it('手填的重复组合也拦下来：没有目录可置灰，就靠行内错误和灰掉的保存', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: unknown[] = []

    // 这个平台没有目录：模型 id 只能手填，置灰无从谈起。
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
        <ModelDialog
          open
          onOpenChange={() => {}}
          onSubmit={(model) => submitted.push(model)}
        />
      ),
    })

    await user.type(screen.getByLabelText('对外 id'), 'buddy-max')
    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    await pickGroup(user, 0, /MiniMax Code/)
    await user.type(screen.getByLabelText('平台模型 id'), 'glm-5.3-flash')
    await user.click(screen.getByRole('button', { name: '加一个目标' }))
    await pickGroup(user, 1, /MiniMax Code/)

    const inputs = screen.getAllByLabelText('平台模型 id')
    await user.type(inputs[1], 'glm-5.3-flash')

    expect(
      screen.getByText(/minimax \/ glm-5\.3-flash 已经有一行了/)
    ).toBeInTheDocument()
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()

    await user.click(save)
    expect(submitted).toEqual([])
  })
})
