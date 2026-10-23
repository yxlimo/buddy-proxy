import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import {
  CatalogModelSchema,
  ListModelsResponseSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { ModelPicker } from '@/features/models/model-picker'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 目录拉不到的时候退回手填，但要说明白为什么。
 *
 * 静悄悄地退化成一个输入框，用户会以为「就只能手填」。
 */
describe('上游模型 id 的目录', () => {
  it('目录是空的：说清楚「没有目录，手填模型 id」', async () => {
    const client = mockAdminClient({
      ListModels: () => create(ListModelsResponseSchema, { models: [] }),
    })

    renderWithClient({
      client,
      children: (
        <ModelPicker groupName='qoder' value='' onChange={() => {}} />
      ),
    })

    expect(
      await screen.findByText('这个上游没有目录，手填模型 id。')
    ).toBeInTheDocument()
    // 退回来的确实是一个输入框。
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('目录里有东西：不说那句，手填也不说', async () => {
    const client = mockAdminClient({
      ListModels: () =>
        create(ListModelsResponseSchema, {
          models: [
            create(CatalogModelSchema, { id: 'MiniMax-M3', displayName: 'M3' }),
          ],
        }),
    })

    renderWithClient({
      client,
      children: (
        <ModelPicker groupName='minimax' value='' onChange={() => {}} />
      ),
    })

    // 是下拉，不是输入框。
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument()
    })
    expect(
      screen.queryByText('这个上游没有目录，手填模型 id。')
    ).not.toBeInTheDocument()
  })

  it('还没选组：提示先选组', async () => {
    const client = mockAdminClient({
      ListModels: () => create(ListModelsResponseSchema, { models: [] }),
    })

    renderWithClient({
      client,
      children: <ModelPicker groupName='' value='' onChange={() => {}} />,
    })

    expect(
      await screen.findByText('先选 Provider 组，才有模型目录可选。')
    ).toBeInTheDocument()
  })

  it('取目录失败：说的是失败，不说「没有目录」', async () => {
    const client = mockAdminClient({
      ListModels: () => {
        throw new Error('boom')
      },
    })

    renderWithClient({
      client,
      children: (
        <ModelPicker groupName='qoder' value='' onChange={() => {}} />
      ),
    })

    expect(
      await screen.findByText('取模型目录失败，手填一个上游模型 id。')
    ).toBeInTheDocument()
  })
})
