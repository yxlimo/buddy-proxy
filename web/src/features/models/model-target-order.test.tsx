import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
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
  type PublishedModel,
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

/** 两个平台，各自有模型目录。 */
function catalogClient() {
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

/**
 * 三个目标，次序照服务端回的（已经是权重从大到小）：a、b、c。
 *
 * 三个都填全了、组合互不相同，一打开就存得下去。
 */
function threeTargets(): PublishedModel {
  const target = (
    groupName: string,
    upstreamModel: string,
    weight: number
  ) =>
    create(PublishedTargetSchema, {
      groupName,
      upstreamModel,
      weight,
      enabled: true,
    })
  return create(PublishedModelSchema, {
    id: 'buddy-max',
    displayName: 'buddy-max',
    enabled: true,
    strategy: 'fallback',
    targets: [
      target('tokenrhythm', 'glm-5.3-flash', 30),
      target('tokenrhythm', 'neohorse-1-9b', 20),
      target('workbuddy-cn', 'glm-5.3-air', 10),
    ],
  })
}

/** 拖拽事件里那份搬运工：jsdom 没有 DataTransfer，凑一个够用的。 */
function dataTransfer() {
  return { setData: () => {}, getData: () => '', effectAllowed: '', dropEffect: '' }
}

/** 目标列表里的各行。 */
function rows(): HTMLElement[] {
  return within(
    screen.getByRole('list', { name: '目标顺序' })
  ).getAllByRole('listitem')
}

/** 界面上各行的上游模型 id，按显示的次序。 */
function listedModels(): string[] {
  return rows().map((row) => {
    const combos = within(row).getAllByRole('combobox')
    return combos[combos.length - 1].textContent ?? ''
  })
}

/** 界面上各行的权重那一行字。 */
function listedWeights(): string[] {
  return rows().map((row) => {
    const node = within(row).queryByText(/^权重 /)
    return node?.textContent ?? ''
  })
}

function dialog(submitted: PublishedModel[]) {
  return (
    <ModelDialog
      open
      model={threeTargets()}
      onOpenChange={() => {}}
      onSubmit={(model) => submitted.push(model)}
    />
  )
}

describe('目标的顺序即权重', () => {
  it('拖动一行放到另一行上：次序跟着换，权重按新的位次重算', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    expect(listedModels()).toEqual([
      'glm-5.3-flash',
      'neohorse-1-9b',
      'glm-5.3-air',
    ])
    expect(listedWeights()).toEqual(['权重 3', '权重 2', '权重 1'])

    // 第一行拖到最后一行上：它换到那个位次。
    const transfer = dataTransfer()
    const source = rows()[0].querySelector('[data-drag-handle]') as HTMLElement
    fireEvent.dragStart(source, { dataTransfer: transfer })
    fireEvent.dragOver(rows()[2], { dataTransfer: transfer })
    fireEvent.drop(rows()[2], { dataTransfer: transfer })

    expect(listedModels()).toEqual([
      'neohorse-1-9b',
      'glm-5.3-air',
      'glm-5.3-flash',
    ])
    // 权重跟着位次走：第一个最大。
    expect(listedWeights()).toEqual(['权重 3', '权重 2', '权重 1'])

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(
      submitted[0].targets.map((target) => [
        target.upstreamModel,
        target.weight,
      ])
    ).toEqual([
      ['neohorse-1-9b', 3],
      ['glm-5.3-air', 2],
      ['glm-5.3-flash', 1],
    ])
  })

  it('焦点在行上时 Alt + 下箭头把这一行往下挪一位', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    fireEvent.keyDown(rows()[0], { key: 'ArrowDown', altKey: true })

    expect(listedModels()).toEqual([
      'neohorse-1-9b',
      'glm-5.3-flash',
      'glm-5.3-air',
    ])

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(
      submitted[0].targets.map((target) => [
        target.upstreamModel,
        target.weight,
      ])
    ).toEqual([
      ['neohorse-1-9b', 3],
      ['glm-5.3-flash', 2],
      ['glm-5.3-air', 1],
    ])
  })

  it('行尾的「下移」把下一行挪上来，第一行的「上移」是灰的', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    expect(screen.getByRole('button', { name: '上移目标 1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下移目标 3' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '下移目标 1' }))

    expect(listedModels()).toEqual([
      'neohorse-1-9b',
      'glm-5.3-flash',
      'glm-5.3-air',
    ])

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(submitted[0].targets.map((target) => target.upstreamModel)).toEqual([
      'neohorse-1-9b',
      'glm-5.3-flash',
      'glm-5.3-air',
    ])
  })

  it('删掉的目标不再出现在保存结果里，剩下的权重重新排', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    await user.click(screen.getByRole('button', { name: '删除目标 2' }))

    expect(listedModels()).toEqual(['glm-5.3-flash', 'glm-5.3-air'])
    expect(listedWeights()).toEqual(['权重 2', '权重 1'])

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(
      submitted[0].targets.map((target) => [
        target.upstreamModel,
        target.weight,
      ])
    ).toEqual([
      ['glm-5.3-flash', 2],
      ['glm-5.3-air', 1],
    ])
  })

  it('目标上没有启用开关：保存时一律写开', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))

    for (const row of rows()) {
      expect(within(row).queryAllByRole('switch')).toHaveLength(0)
    }

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(submitted[0].targets.map((target) => target.enabled)).toEqual([
      true,
      true,
      true,
    ])
  })
})
