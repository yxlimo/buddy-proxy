import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { PublishedModelSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { fromDraft, toDraft } from '@/features/models/model-dialog'

/**
 * 策略与权重。
 *
 * single 只走一个目标，权重没有意义：输入框不画，发出去的权重统一是 1。
 */
describe('策略与权重', () => {
  it('single：发出去的权重是 1，草稿里残留的权重不带进请求', () => {
    const draft = toDraft(
      create(PublishedModelSchema, {
        id: 'buddy-max',
        strategy: 'single',
      })
    )
    draft.targets = [
      {
        groupName: 'minimax',
        upstreamModel: 'MiniMax-M2',
        weight: '7',
        enabled: true,
      },
    ]

    const model = fromDraft(draft)
    expect(model.strategy).toBe('single')
    expect(model.targets[0].weight).toBe(1)
  })

  it('fallback：权重照着草稿发', () => {
    const draft = toDraft(
      create(PublishedModelSchema, {
        id: 'buddy-max',
        strategy: 'fallback',
      })
    )
    draft.targets = [
      {
        groupName: 'minimax',
        upstreamModel: 'MiniMax-M2',
        weight: '7',
        enabled: true,
      },
      {
        groupName: 'qoder-cn',
        upstreamModel: 'claude-sonnet-4',
        weight: '2',
        enabled: true,
      },
    ]

    const model = fromDraft(draft)
    expect(model.targets[0].weight).toBe(7)
    expect(model.targets[1].weight).toBe(2)
  })

  it('从 fallback 切成 single 之后，权重又变回 1', () => {
    const draft = toDraft(
      create(PublishedModelSchema, {
        id: 'buddy-max',
        strategy: 'fallback',
      })
    )
    draft.targets = [
      {
        groupName: 'minimax',
        upstreamModel: 'MiniMax-M2',
        weight: '9',
        enabled: true,
      },
    ]

    // 界面上切了策略：草稿里的策略变了，权重还留着（那是界面上的残留值）。
    draft.strategy = 'single'
    expect(fromDraft(draft).targets[0].weight).toBe(1)
  })
})
