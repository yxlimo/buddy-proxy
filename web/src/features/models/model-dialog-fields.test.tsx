import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CatalogModelSchema,
  ListModelsResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { ModelDialog } from '@/features/models/model-dialog'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

function catalogClient() {
  return mockAdminClient({
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

describe('模型编辑弹窗', () => {
  it('必填项没填的时候，所在的分组标题上标红', async () => {
    const user = userEvent.setup()
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    // 一开始两个分组都有没填的必填项。
    const basicTab = screen.getByRole('tab', { name: /基本/ })
    const targetsTab = screen.getByRole('tab', { name: /上游目标/ })
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
    const user = userEvent.setup()
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    await user.click(screen.getByRole('tab', { name: /上游目标/ }))

    expect(
      screen.getByText('至少要有一个填全的目标：上游组和上游模型 id 都要填。')
    ).toBeInTheDocument()
  })

  it('选了上游组之后，上游模型 id 变成目录里的下拉', async () => {
    const user = userEvent.setup()
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    await user.click(screen.getByRole('tab', { name: /上游目标/ }))

    // 还没选组：没有目录，输入框手填。
    expect(screen.getByText(/先选上游组/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('上游组'), 'qoder')

    // 目录拉回来之后变成下拉。
    const picker = await screen.findByRole('combobox', {
      name: '上游模型 id',
    })
    await user.click(picker)

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('claude-sonnet-4')).toBeInTheDocument()
    expect(within(listbox).getByText('claude-opus-4')).toBeInTheDocument()
  })

  it('目录拉不到的时候退回手填', async () => {
    const user = userEvent.setup()
    const client = mockAdminClient({
      ListModels: () => create(ListModelsResponseSchema, { models: [] }),
    })

    renderWithClient({
      client,
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    await user.click(screen.getByRole('tab', { name: /上游目标/ }))
    await user.type(screen.getByLabelText('上游组'), 'minimax')

    await waitFor(() => {
      expect(
        screen.getByText('这个组没有模型目录，手填一个上游模型 id。')
      ).toBeInTheDocument()
    })
    // 手填的输入框在。
    expect(screen.getByLabelText('上游模型 id')).toBeInTheDocument()
  })

  it('只有权重，没有顺序，权重有解释', async () => {
    renderWithClient({
      client: catalogClient(),
      children: (
        <ModelDialog open onOpenChange={() => {}} onSubmit={() => {}} />
      ),
    })

    await userEvent.setup().click(screen.getByRole('tab', { name: /上游目标/ }))

    expect(screen.getByLabelText('权重')).toBeInTheDocument()
    expect(screen.queryByLabelText('顺序')).not.toBeInTheDocument()
    expect(screen.getByText('权重大的先试，失败了才试小的。')).toBeInTheDocument()
  })
})
