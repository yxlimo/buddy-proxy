import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { PublishedModelSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { fromDraft, targetWeight, toDraft } from '@/features/models/model-dialog'

/**
 * 顺序即权重。
 *
 * 后端按权重从大到小试目标，所以排在最上面的拿最大的权重：面板不再让人手填
 * 权重，位置一挪，权重跟着重算。
 */
describe('顺序与权重', () => {
  it('权重按位次从大到小填，第一个最大', () => {
    expect(targetWeight(0, 3)).toBe(3)
    expect(targetWeight(1, 3)).toBe(2)
    expect(targetWeight(2, 3)).toBe(1)
    // 只有一个目标时权重就是 1。
    expect(targetWeight(0, 1)).toBe(1)
  })

  it('fallback：发出去的权重照草稿的先后，第一个最大', () => {
    const draft = toDraft(
      create(PublishedModelSchema, {
        id: 'buddy-max',
        strategy: 'fallback',
      })
    )
    draft.targets = [
      { groupName: 'minimax', upstreamModel: 'MiniMax-M2' },
      { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4' },
    ]

    const model = fromDraft(draft)
    expect(model.targets.map((target) => target.weight)).toEqual([2, 1])
  })

  it('single：只有一个目标，权重也按顺序填（就是 1）', () => {
    const draft = toDraft(
      create(PublishedModelSchema, {
        id: 'buddy-max',
        strategy: 'single',
      })
    )
    draft.targets = [{ groupName: 'minimax', upstreamModel: 'MiniMax-M2' }]

    const model = fromDraft(draft)
    expect(model.strategy).toBe('single')
    expect(model.targets[0].weight).toBe(1)
  })

  it('目标上一律写 enabled，读的时候不看它', () => {
    const model = create(PublishedModelSchema, {
      id: 'buddy-max',
      strategy: 'fallback',
      targets: [
        { groupName: 'minimax', upstreamModel: 'MiniMax-M2', weight: 9, enabled: false },
        { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4', weight: 4, enabled: true },
      ],
    })

    // 读：开着关着都一样画，草稿里没有这一格。
    const draft = toDraft(model)
    expect(draft.targets).toEqual([
      { groupName: 'minimax', upstreamModel: 'MiniMax-M2' },
      { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4' },
    ])

    // 写：全部写开。不想去这个目标就把它删掉。
    expect(fromDraft(draft).targets.map((target) => target.enabled)).toEqual([
      true,
      true,
    ])
  })

  it('服务端的次序读进来就照原样摆：后端已经是权重从大到小', () => {
    const model = create(PublishedModelSchema, {
      id: 'buddy-max',
      strategy: 'fallback',
      targets: [
        { groupName: 'minimax', upstreamModel: 'MiniMax-M2', weight: 30, enabled: true },
        { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4', weight: 20, enabled: true },
      ],
    })

    expect(toDraft(model).targets.map((target) => target.upstreamModel)).toEqual([
      'MiniMax-M2',
      'claude-sonnet-4',
    ])
  })
})
