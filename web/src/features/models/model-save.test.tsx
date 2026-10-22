import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ListPublishedModelsResponseSchema,
  PublishedModelSchema,
  SavePublishedModelResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { PublishedModelsPage } from '@/features/models/index'
import { ModelDialog, fromDraft, toDraft } from '@/features/models/model-dialog'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: toastSuccess,
  }),
  Toaster: () => null,
}))

describe('模型保存失败的时候', () => {
  it('报的是失败，不是成功，弹窗也不关', async () => {
    const user = userEvent.setup()
    toastError.mockClear()
    toastSuccess.mockClear()

    const client = mockAdminClient({
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, { models: [] }),
      SavePublishedModel: () =>
        create(SavePublishedModelResponseSchema, {
          ok: false,
          message: '模型至少要有一个上游',
        }),
    })

    renderWithClient({ client, children: <PublishedModelsPage /> })

    await user.click(await screen.findByRole('button', { name: '新建' }))
    await user.type(screen.getByLabelText('对外 id'), 'buddy-max')

    await user.click(screen.getByRole('tab', { name: '上游目标' }))
    await user.type(screen.getByLabelText('上游组'), 'qoder')
    await user.type(screen.getByLabelText('上游模型 id'), 'claude-sonnet-4')

    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('模型至少要有一个上游')
    })
    // 绿色成功提示不能有。
    expect(toastSuccess).not.toHaveBeenCalled()
    // 弹窗留着，用户填的东西还在。
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('上游组')).toHaveValue('qoder')
    expect(screen.getByLabelText('上游模型 id')).toHaveValue('claude-sonnet-4')
  })

  it('目标没填全的时候保存按钮是灰的', async () => {
    const user = userEvent.setup()

    render(
      <ModelDialog
        open
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />
    )

    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()

    // 目标那一页里，没填全的行有行内提示。
    await user.click(screen.getByRole('tab', { name: '上游目标' }))
    expect(screen.getByText(/这一行还没填全/)).toBeInTheDocument()

    // 填了对外 id 还是不够：目标也是空的。
    await user.click(screen.getByRole('tab', { name: '基本' }))
    await user.type(screen.getByLabelText('对外 id'), 'buddy-max')
    expect(save).toBeDisabled()

    await user.click(screen.getByRole('tab', { name: '上游目标' }))
    await user.type(screen.getByLabelText('上游组'), 'qoder')
    expect(save).toBeDisabled()

    await user.type(screen.getByLabelText('上游模型 id'), 'claude-sonnet-4')
    expect(save).toBeEnabled()
  })
})

describe('元数据的继承', () => {
  it('继承上游的不会被写死成具体数字', () => {
    const model = create(PublishedModelSchema, {
      id: 'buddy-max',
      displayName: 'Buddy Max',
      strategy: 'fallback',
      // 这四个不给 = 继承目标的值
    })

    const draft = toDraft(model)
    expect(draft.contextWindowInherit).toBe(true)
    expect(draft.maxOutputTokensInherit).toBe(true)
    expect(draft.reasoning).toBe('inherit')
    expect(draft.toolCall).toBe('inherit')

    const saved = fromDraft(draft)
    expect(saved.contextWindow).toBeUndefined()
    expect(saved.maxOutputTokens).toBeUndefined()
    expect(saved.reasoning).toBeUndefined()
    expect(saved.toolCall).toBeUndefined()
  })

  it('自己指定过的照着写回去', () => {
    const model = create(PublishedModelSchema, {
      id: 'buddy-max',
      contextWindow: 200000,
      maxOutputTokens: 64000,
      reasoning: true,
      toolCall: false,
    })

    const draft = toDraft(model)
    expect(draft.contextWindowInherit).toBe(false)
    expect(draft.reasoning).toBe('yes')
    expect(draft.toolCall).toBe('no')

    const saved = fromDraft(draft)
    expect(saved.contextWindow).toBe(200000)
    expect(saved.maxOutputTokens).toBe(64000)
    expect(saved.reasoning).toBe(true)
    expect(saved.toolCall).toBe(false)
  })

  it('没填全的目标不会发出去', () => {
    const draft = toDraft(undefined)
    draft.targets = [
      { groupName: 'qoder', upstreamModel: '', weight: '1', position: '0', enabled: true },
      { groupName: '', upstreamModel: 'claude', weight: '1', position: '0', enabled: true },
    ]
    expect(fromDraft(draft).targets).toHaveLength(0)
  })
})
