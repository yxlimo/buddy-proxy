import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ListPublishedModelsResponseSchema,
  PublishedModelSchema,
  PublishedTargetSchema,
  SavePublishedModelResponseSchema,
  type PublishedModel,
} from '@/gen/buddy/admin/v1/admin_pb'
import { PublishedModelsPage } from '@/features/models/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: toastSuccess,
  }),
  Toaster: () => null,
}))

function model(id: string, enabled: boolean): PublishedModel {
  return create(PublishedModelSchema, {
    id,
    displayName: id.toUpperCase(),
    enabled,
    published: enabled,
    strategy: 'single',
    targets: [
      create(PublishedTargetSchema, {
        groupName: 'minimax',
        upstreamModel: 'MiniMax-M3',
        weight: 1,
        enabled: true,
      }),
    ],
  })
}

/**
 * 列表里直接发布/停用。
 *
 * 不用为了发一个模型去打开编辑弹窗翻开关。
 */
describe('主路由模型的发布与停用', () => {
  it('没启用的有「发布」，启用的有「停用」', async () => {
    const client = mockAdminClient({
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [model('off-model', false), model('on-model', true)],
        }),
    })

    renderWithClient({ client, children: <PublishedModelsPage /> })

    expect(await screen.findByRole('button', { name: '发布' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停用' })).toBeInTheDocument()
    // 一个发布按钮、一个停用按钮。
    expect(screen.getAllByRole('button', { name: '发布' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '停用' })).toHaveLength(1)
  })

  it('点「发布」把模型原样存一遍，enabled 变成 true', async () => {
    const user = userEvent.setup({ delay: null })
    const saved: PublishedModel[] = []
    const client = mockAdminClient({
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [model('off-model', false)],
        }),
      SavePublishedModel: (input) => {
        const sent = input.model as PublishedModel
        saved.push(sent)
        return create(SavePublishedModelResponseSchema, {
          ok: true,
          id: sent.id,
          message: '发布了',
        })
      },
    })

    renderWithClient({ client, children: <PublishedModelsPage /> })

    await user.click(await screen.findByRole('button', { name: '发布' }))

    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    const sent = saved[0]
    expect(sent.id).toBe('off-model')
    expect(sent.enabled).toBe(true)
    // 别的字段一个都没丢。
    expect(sent.displayName).toBe('OFF-MODEL')
    expect(sent.strategy).toBe('single')
    expect(sent.targets).toHaveLength(1)
    expect(sent.targets[0].upstreamModel).toBe('MiniMax-M3')
  })

  it('停用要先确认', async () => {
    const user = userEvent.setup({ delay: null })
    const saved: PublishedModel[] = []
    const client = mockAdminClient({
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [model('on-model', true)],
        }),
      SavePublishedModel: (input) => {
        const sent = input.model as PublishedModel
        saved.push(sent)
        return create(SavePublishedModelResponseSchema, { ok: true })
      },
    })

    renderWithClient({ client, children: <PublishedModelsPage /> })

    await user.click(await screen.findByRole('button', { name: '停用' }))

    // 还没确认，什么都没存。
    expect(await screen.findByText('停用这个模型？')).toBeInTheDocument()
    expect(saved).toHaveLength(0)

    // 确认了才存。
    const buttons = screen.getAllByRole('button', { name: '停用' })
    await user.click(buttons[buttons.length - 1])

    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(saved[0].enabled).toBe(false)
    expect(saved[0].id).toBe('on-model')
  })

  it('取消确认就不动', async () => {
    const user = userEvent.setup({ delay: null })
    const saved: PublishedModel[] = []
    const client = mockAdminClient({
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [model('on-model', true)],
        }),
      SavePublishedModel: (input) => {
        const sent = input.model as PublishedModel
        saved.push(sent)
        return create(SavePublishedModelResponseSchema, { ok: true })
      },
    })

    renderWithClient({ client, children: <PublishedModelsPage /> })

    await user.click(await screen.findByRole('button', { name: '停用' }))
    await user.click(await screen.findByRole('button', { name: '取消' }))

    await waitFor(() => {
      expect(
        screen.queryByText('停用这个模型？')
      ).not.toBeInTheDocument()
    })
    expect(saved).toHaveLength(0)
  })
})
