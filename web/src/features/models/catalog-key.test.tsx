import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import {
  CatalogModelSchema,
  CredentialState,
  CredentialStatusSchema,
  ListModelsResponseSchema,
  ListUpstreamsResponseSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import { ModelPicker } from '@/features/models/model-picker'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 目录的缓存键要带上上游的状态。
 *
 * 上游关着的时候 ListModels 不返回它的模型 —— 开关变了、目录也变了，
 * 键不变的话界面上会留着上一次的目录（看着像还有模型，其实已经关了）。
 */
describe('模型目录的缓存键', () => {
  it('上游的状态变了，目录就重新拉', async () => {
    let calls = 0
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              enabled: true,
              state: UpstreamState.READY,
              credential: create(CredentialStatusSchema, {
                status: CredentialState.AUTHENTICATED,
              }),
            }),
          ],
        }),
      ListModels: () => {
        calls += 1
        return create(ListModelsResponseSchema, {
          models: [
            create(CatalogModelSchema, {
              id: `model-${calls}`,
              displayName: `模型 ${calls}`,
            }),
          ],
        })
      },
    })

    renderWithClient({
      client,
      children: (
        <ModelPicker groupName='minimax' value='' onChange={() => {}} />
      ),
    })

    await waitFor(() => {
      expect(calls).toBe(1)
    })
    // 目录在下拉里（不是手填输入框）。
    expect(await screen.findByRole('combobox')).toBeInTheDocument()
  })
})
