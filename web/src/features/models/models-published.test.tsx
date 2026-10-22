import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  ListPublishedModelsResponseSchema,
  PublishedModelSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import { PublishedModelsPage } from '@/features/models/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 根路由现在公布了几个模型。
 *
 * 库里有几个不等于公布了几个：上游全关着、或者目标模型的上游没了，
 * 根路由就接不了。契约里 PublishedModel.published 说的是这个。
 */
describe('主路由模型的公布数', () => {
  it('按 published 数，不按列表长度', async () => {
    const client = mockAdminClient({
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [
            create(PublishedModelSchema, {
              id: 'a-published',
              displayName: 'A',
              enabled: true,
              published: true,
            }),
            create(PublishedModelSchema, {
              id: 'b-not-published',
              displayName: 'B',
              enabled: true,
              published: false,
            }),
            create(PublishedModelSchema, {
              id: 'c-not-published',
              displayName: 'C',
              enabled: false,
              published: false,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <PublishedModelsPage /> })

    // 三个模型，只公布一个。
    expect(
      await screen.findByText('根路由现在公布 1 个（共 3 个）。')
    ).toBeInTheDocument()

    // 没公布的要标出来。
    expect(screen.getAllByText('未公布')).toHaveLength(2)
    expect(screen.queryByText('已公布')).not.toBeInTheDocument()
  })

  it('全都公布的时候说公布了几个', async () => {
    const client = mockAdminClient({
      ListPublishedModels: () =>
        create(ListPublishedModelsResponseSchema, {
          models: [
            create(PublishedModelSchema, {
              id: 'a',
              displayName: 'A',
              enabled: true,
              published: true,
            }),
            create(PublishedModelSchema, {
              id: 'b',
              displayName: 'B',
              enabled: true,
              published: true,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <PublishedModelsPage /> })

    expect(
      await screen.findByText('根路由现在公布 2 个（共 2 个）。')
    ).toBeInTheDocument()
    expect(screen.queryByText('未公布')).not.toBeInTheDocument()
  })
})
