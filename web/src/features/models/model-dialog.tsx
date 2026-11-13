import { useEffect, useState } from 'react'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { create } from '@bufbuild/protobuf'
import {
  PublishedModelSchema,
  PublishedTargetSchema,
  type PublishedModel,
  type PublishedTarget,
} from '@/gen/buddy/admin/v1/admin_pb'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ModelPicker } from '@/features/models/model-picker'
import { GroupPicker } from '@/features/models/group-picker'
import { intFieldProblem } from '@/lib/int-field'
import { cn } from '@/lib/utils'

/**
 * 三个取值：继承上游的、自己指定开、自己指定关。
 *
 * 契约里上下文长度、输出上限、是否思考、是否工具都是 optional 的：
 * 不给就是继承目标的值，给了就是用这个值。以前面板把它们当普通值处理，
 * 编辑一次就把「继承」写死成了具体数字。
 */
type TriState = 'inherit' | 'yes' | 'no'

type ModelDraft = {
  id: string
  displayName: string
  enabled: boolean
  strategy: string
  contextWindow: string
  contextWindowInherit: boolean
  maxOutputTokens: string
  maxOutputTokensInherit: boolean
  /** 现算出来的值：继承时显示它，开关照旧是继承。 */
  effectiveContextWindow?: number
  effectiveMaxOutputTokens?: number
  reasoning: TriState
  toolCall: TriState
  effortOptions: string
  /**
   * 目标的先后。列表里的位置就是权重，草稿里不存权重数字：
   * 拖动一改位置，权重跟着重新算。
   */
  targets: {
    groupName: string
    upstreamModel: string
  }[]
}

function emptyTarget() {
  return {
    groupName: '',
    upstreamModel: '',
  }
}

/**
 * 位次即权重：第 index 个目标（共 total 个）的权重。
 *
 * 后端按权重从大到小试目标 —— 读表时 `ORDER BY ... weight DESC`，保存时也按
 * 权重从大到小排序，proto 里写的是「权重：大的先试」。所以排在最上面的那个
 * 拿最大的权重，往下依次小一个：顺序就是先后，不再手填数字。
 */
export function targetWeight(index: number, total: number): number {
  return total - index
}

/** 一行的目标填全了没有。 */
function targetFilled(target: ModelDraft['targets'][number]): boolean {
  return target.groupName.trim() !== '' && target.upstreamModel.trim() !== ''
}

/**
 * 判重按组合（平台, 上游模型），不按单个字段：
 * 同一个平台上挂两个不同的模型、或者同一个模型挂在两个平台上，都是正常的。
 */
function targetKey(groupName: string, upstreamModel: string): string {
  return `${groupName.trim()}\u0000${upstreamModel.trim()}`
}

/**
 * 组合重复的行：行号 → 这个组合第一次出现在第几行（从 1 数，给用户看）。
 *
 * 只标后面那几行：用户看到的错是「这一行和上面某一行撞了」。
 * 后端建表时 (model_id, group_name, upstream_model) 是主键，撞了存不下，
 * 所以这种草稿根本没出门的必要。
 */
function duplicateTargets(targets: ModelDraft['targets']): Map<number, number> {
  const seen = new Map<string, number>()
  const duplicated = new Map<number, number>()
  targets.forEach((target, index) => {
    if (!targetFilled(target)) return
    const key = targetKey(target.groupName, target.upstreamModel)
    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, index)
      return
    }
    duplicated.set(index, first)
  })
  return duplicated
}

export function toDraft(model: PublishedModel | undefined): ModelDraft {
  if (!model) {
    return {
      id: '',
      displayName: '',
      enabled: true,
      strategy: 'single',
      contextWindow: '',
      contextWindowInherit: true,
      maxOutputTokens: '',
      maxOutputTokensInherit: true,
      reasoning: 'inherit',
      toolCall: 'inherit',
      effortOptions: '',
      targets: [emptyTarget()],
    }
  }
  return {
    id: model.id,
    displayName: model.displayName,
    enabled: model.enabled,
    strategy: model.strategy || 'single',
    // 服务端回的是库里存的那个：空就是继承。
    // effective 里是现算的值 —— 继承时界面上要显示它，但开关不能因为它
    // 变成「不继承」：那会把继承写死成具体数字。
    contextWindow:
      model.contextWindow === undefined ? '' : String(model.contextWindow),
    contextWindowInherit: model.contextWindow === undefined,
    maxOutputTokens:
      model.maxOutputTokens === undefined
        ? ''
        : String(model.maxOutputTokens),
    maxOutputTokensInherit: model.maxOutputTokens === undefined,
    effectiveContextWindow: model.effective?.contextWindow,
    effectiveMaxOutputTokens: model.effective?.maxOutputTokens,
    reasoning: toTriState(model.reasoning),
    toolCall: toTriState(model.toolCall),
    effortOptions: model.effortOptions.join(', '),
    // 服务端回的目标已经按权重从大到小排好，读进来就是界面上要显示的先后。
    // 目标上的 enabled 不读了：面板没有这个开关，保存时一律写开。
    targets: model.targets.map((target) => ({
      groupName: target.groupName,
      upstreamModel: target.upstreamModel,
    })),
  }
}

/** 继承时把现在实际的值显示出来。 */
function inheritedHint(value: number | undefined): string {
  if (value === undefined) return '继承平台'
  return `继承平台（现在 ${value.toLocaleString()}）`
}

function toTriState(value: boolean | undefined): TriState {
  if (value === undefined) return 'inherit'
  return value ? 'yes' : 'no'
}

export function fromDraft(draft: ModelDraft): PublishedModel {
  return {
    ...create(PublishedModelSchema),
    id: draft.id.trim(),
    displayName: draft.displayName.trim() || draft.id.trim(),
    enabled: draft.enabled,
    strategy: draft.strategy,
    // 继承的字段不给值：不给就是继承，给了就是用这个值。
    contextWindow: draft.contextWindowInherit
      ? undefined
      : Number(draft.contextWindow) || 0,
    maxOutputTokens: draft.maxOutputTokensInherit
      ? undefined
      : Number(draft.maxOutputTokens) || 0,
    reasoning: fromTriState(draft.reasoning),
    toolCall: fromTriState(draft.toolCall),
    // 空 = 继承目标支持的档位。
    effortOptions: draft.effortOptions
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    // 位次即权重：按草稿里的先后填，第一个最大。single 也一样填 —— 只有一个
    // 目标时顺序没有意义，权重仍然是它自己那一个。
    targets: draft.targets
      .filter(targetFilled)
      .map((target, index, all): PublishedTarget => ({
        ...create(PublishedTargetSchema),
        groupName: target.groupName.trim(),
        upstreamModel: target.upstreamModel.trim(),
        weight: targetWeight(index, all.length),
        // 目标上没有开关了：想不去这个目标就把它删掉。后端还按这一列判
        // 「这个目标参不参与选路」，所以一律写开。
        enabled: true,
        // requests / failed 是网关的计数，只读：保存时会被覆盖。
        requests: 0n,
        failed: 0n,
      })),
    updatedAt: 0n,
  }
}

function fromTriState(state: TriState): boolean | undefined {
  if (state === 'inherit') return undefined
  return state === 'yes'
}

type ModelDialogProps = {
  open: boolean
  model?: PublishedModel
  onOpenChange: (open: boolean) => void
  onSubmit: (model: PublishedModel) => void
  busy?: boolean
}

export function ModelDialog({
  open,
  model,
  onOpenChange,
  onSubmit,
  busy,
}: ModelDialogProps) {
  const [draft, setDraft] = useState<ModelDraft>(() => toDraft(model))
  const [tab, setTab] = useState('basic')
  /** 正在拖的那一行（草稿里的行号）。 */
  const [dragging, setDragging] = useState<number | null>(null)

  useEffect(() => {
    if (open) setDraft(toDraft(model))
  }, [open, model])

  const patch = (part: Partial<ModelDraft>) =>
    setDraft((prev) => ({ ...prev, ...part }))

  const patchTarget = (
    index: number,
    part: Partial<ModelDraft['targets'][number]>
  ) =>
    setDraft((prev) => ({
      ...prev,
      targets: prev.targets.map((target, i) =>
        i === index ? { ...target, ...part } : target
      ),
    }))

  /** 把第 from 行挪到第 to 位。越界或原地不动时不动。 */
  const moveTarget = (from: number, to: number) =>
    setDraft((prev) => {
      if (from === to) return prev
      if (from < 0 || to < 0 || from >= prev.targets.length) return prev
      if (to >= prev.targets.length) return prev
      const targets = [...prev.targets]
      const [moved] = targets.splice(from, 1)
      targets.splice(to, 0, moved)
      return { ...prev, targets }
    })

  // 按填全了的目标数算，不是按行数：没填全的行会被过滤掉，拿行数算会
  // 放行一个「发出去是空 targets」的请求。
  const filledTargets = draft.targets.filter(targetFilled)

  // 每一行将要发的权重：只给填全了的行算，没填全的行本来也发不出去。
  const weights = new Map<number, number>()
  draft.targets.forEach((target, index) => {
    if (!targetFilled(target)) return
    weights.set(
      index,
      targetWeight(filledTargets.indexOf(target), filledTargets.length)
    )
  })

  // 组合撞了的行：后端存不下这种草稿（主键 (model_id, group_name,
  // upstream_model)），所以在这里就拦住，不发请求。
  const duplicated = duplicateTargets(draft.targets)

  /**
   * 这一行能选的上游模型里，哪些已经被别的行占着了。
   * 只有同一个平台才有意义：判重是组合，不是单个模型 id。
   */
  const takenModelIds = (index: number): string[] => {
    const group = draft.targets[index]?.groupName.trim() ?? ''
    if (group === '') return []
    return draft.targets
      .filter((target, i) => {
        if (i === index) return false
        return (
          target.groupName.trim() === group &&
          target.upstreamModel.trim() !== ''
        )
      })
      .map((target) => target.upstreamModel.trim())
  }

  // 哪个分组里有没填的必填项：分组标题上标红，切过去给行内提示。
  const basicMissing = draft.id.trim().length === 0
  const targetsMissing = filledTargets.length === 0
  // 组合撞了也是「平台目标」那一页的问题：保存灰着的时候，用户得知道去哪看。
  const targetsProblem = targetsMissing || duplicated.size > 0
  // 两个整数格：继承时不判（那两格灰着，值不属于这一单），填了才判。
  const contextProblem = draft.contextWindowInherit
    ? null
    : intFieldProblem(draft.contextWindow)
  const outputProblem = draft.maxOutputTokensInherit
    ? null
    : intFieldProblem(draft.maxOutputTokens)

  const valid =
    !basicMissing &&
    !targetsMissing &&
    contextProblem === null &&
    outputProblem === null &&
    duplicated.size === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {model ? '编辑主路由模型' : '新增主路由模型'}
          </DialogTitle>
          <DialogDescription>
            对外公布一个 id，背后挂一个或多个平台模型。
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value='basic'>
              基本
              {basicMissing ? <RequiredDot /> : null}
            </TabsTrigger>
            <TabsTrigger value='targets'>
              平台目标
              {targetsProblem ? <RequiredDot /> : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent value='basic' className='grid gap-4'>
            <div className='grid gap-2'>
              <Label htmlFor='model-id'>对外 id</Label>
              <Input
                id='model-id'
                value={draft.id}
                disabled={Boolean(model)}
                aria-invalid={basicMissing || undefined}
                onChange={(event) => patch({ id: event.target.value })}
                placeholder='比如 qoder-max'
              />
              {basicMissing ? (
                <p className='text-xs text-destructive'>
                  对外 id 是必填的。
                </p>
              ) : null}
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='model-name'>显示名</Label>
              <Input
                id='model-name'
                value={draft.displayName}
                onChange={(event) =>
                  patch({ displayName: event.target.value })
                }
                placeholder='留空则与对外 id 相同'
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='model-strategy'>策略</Label>
              <Select
                value={draft.strategy}
                onValueChange={(value) => patch({ strategy: value })}
              >
                <SelectTrigger id='model-strategy'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='single'>single（单一目标）</SelectItem>
                  <SelectItem value='fallback'>fallback（依次回退）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='grid gap-2'>
                <Label htmlFor='model-ctx'>上下文长度</Label>
                <Input
                  id='model-ctx'
                  inputMode='numeric'
                  disabled={draft.contextWindowInherit}
                  aria-invalid={contextProblem ? true : undefined}
                  aria-describedby={
                    contextProblem ? 'model-ctx-problem' : undefined
                  }
                  placeholder={
                    draft.contextWindowInherit
                      ? inheritedHint(draft.effectiveContextWindow)
                      : '留空 = 继承平台'
                  }
                  value={draft.contextWindow}
                  onChange={(event) =>
                    patch({ contextWindow: event.target.value })
                  }
                />
                {contextProblem ? (
                  <p
                    id='model-ctx-problem'
                    className='text-xs text-destructive'
                  >
                    {contextProblem}
                  </p>
                ) : null}
                <InheritToggle
                  id='model-ctx-inherit'
                  label='继承平台'
                  checked={draft.contextWindowInherit}
                  onChange={(checked) =>
                    patch({
                      contextWindowInherit: checked,
                      contextWindow: checked ? '' : draft.contextWindow,
                    })
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label htmlFor='model-out'>最大输出</Label>
                <Input
                  id='model-out'
                  inputMode='numeric'
                  disabled={draft.maxOutputTokensInherit}
                  aria-invalid={outputProblem ? true : undefined}
                  aria-describedby={
                    outputProblem ? 'model-out-problem' : undefined
                  }
                  placeholder={
                    draft.maxOutputTokensInherit
                      ? inheritedHint(draft.effectiveMaxOutputTokens)
                      : '留空 = 继承平台'
                  }
                  value={draft.maxOutputTokens}
                  onChange={(event) =>
                    patch({ maxOutputTokens: event.target.value })
                  }
                />
                {outputProblem ? (
                  <p
                    id='model-out-problem'
                    className='text-xs text-destructive'
                  >
                    {outputProblem}
                  </p>
                ) : null}
                <InheritToggle
                  id='model-out-inherit'
                  label='继承平台'
                  checked={draft.maxOutputTokensInherit}
                  onChange={(checked) =>
                    patch({
                      maxOutputTokensInherit: checked,
                      maxOutputTokens: checked ? '' : draft.maxOutputTokens,
                    })
                  }
                />
              </div>
            </div>

            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='grid gap-2'>
                <Label htmlFor='model-reasoning'>是否支持推理</Label>
                <Select
                  value={draft.reasoning}
                  onValueChange={(value) =>
                    patch({ reasoning: value as TriState })
                  }
                >
                  <SelectTrigger id='model-reasoning'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='inherit'>继承平台</SelectItem>
                    <SelectItem value='yes'>支持</SelectItem>
                    <SelectItem value='no'>不支持</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-2'>
                <Label htmlFor='model-tool-call'>是否支持工具调用</Label>
                <Select
                  value={draft.toolCall}
                  onValueChange={(value) =>
                    patch({ toolCall: value as TriState })
                  }
                >
                  <SelectTrigger id='model-tool-call'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='inherit'>继承平台</SelectItem>
                    <SelectItem value='yes'>支持</SelectItem>
                    <SelectItem value='no'>不支持</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className='grid gap-2'>
              <Label htmlFor='model-effort'>推理档位（逗号分隔）</Label>
              <Input
                id='model-effort'
                value={draft.effortOptions}
                onChange={(event) => patch({ effortOptions: event.target.value })}
                placeholder='low, medium, high'
              />
              <p className='text-xs text-muted-foreground'>
                留空 = 继承目标支持的档位。
              </p>
            </div>

            <label className='flex items-center gap-2 text-sm'>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(checked) => patch({ enabled: checked })}
              />
              启用
            </label>
          </TabsContent>

          <TabsContent value='targets' className='grid gap-3'>
            {targetsMissing ? (
              <p className='text-xs text-destructive'>
                至少要有一个填全的目标：平台组和平台模型 id 都要填。
              </p>
            ) : null}
            <p className='text-xs text-muted-foreground'>
              拖动行调整顺序，排在前面的先接
            </p>
            <ul aria-label='目标顺序' className='grid gap-2'>
              {draft.targets.map((target, index) => {
                const last = index === draft.targets.length - 1
                const weight = weights.get(index)
                return (
                  <li
                    key={index}
                    data-target-row={index}
                    aria-label={`目标 ${index + 1}`}
                    tabIndex={0}
                    // 键盘上的另一条路：焦点在行上时 Alt + 上/下箭头。
                    onKeyDown={(event) => {
                      if (!event.altKey) return
                      if (event.key === 'ArrowUp' && index > 0) {
                        event.preventDefault()
                        moveTarget(index, index - 1)
                      }
                      if (event.key === 'ArrowDown' && !last) {
                        event.preventDefault()
                        moveTarget(index, index + 1)
                      }
                    }}
                    // 落在别的一行上才算一次换位：不 preventDefault 收不到 drop。
                    onDragOver={(event) => {
                      if (dragging !== null && dragging !== index) {
                        event.preventDefault()
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      const from = dragging
                      setDragging(null)
                      if (from === null || from === index) return
                      moveTarget(from, index)
                    }}
                    className={cn(
                      'grid gap-2 rounded-lg border p-3',
                      dragging === index && 'opacity-50'
                    )}
                  >
                    <div className='flex flex-wrap items-center gap-2'>
                      {/* 拖拽把手单独一个元素可拖：整张卡片可拖会抢掉输入框里
                          选字的拖动手势。 */}
                      <span
                        data-drag-handle=''
                        draggable
                        aria-hidden='true'
                        onDragStart={(event) => {
                          setDragging(index)
                          event.dataTransfer?.setData(
                            'text/plain',
                            String(index)
                          )
                          if (event.dataTransfer) {
                            event.dataTransfer.effectAllowed = 'move'
                          }
                        }}
                        onDragEnd={() => setDragging(null)}
                        className='cursor-grab text-muted-foreground'
                      >
                        <GripVertical className='size-4' />
                      </span>
                      <span className='text-sm font-medium'>
                        目标 {index + 1}
                      </span>
                      {weight === undefined ? null : (
                        <span className='text-xs text-muted-foreground'>
                          权重 {weight}
                        </span>
                      )}
                      <span className='ms-auto flex items-center gap-1'>
                        <Button
                          size='sm'
                          variant='outline'
                          aria-label={`上移目标 ${index + 1}`}
                          disabled={index === 0}
                          onClick={() => moveTarget(index, index - 1)}
                        >
                          上移
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          aria-label={`下移目标 ${index + 1}`}
                          disabled={last}
                          onClick={() => moveTarget(index, index + 1)}
                        >
                          下移
                        </Button>
                        <Button
                          variant='ghost'
                          size='sm'
                          aria-label={`删除目标 ${index + 1}`}
                          disabled={draft.targets.length === 1}
                          onClick={() =>
                            setDraft((prev) => ({
                              ...prev,
                              targets: prev.targets.filter(
                                (_, i) => i !== index
                              ),
                            }))
                          }
                        >
                          <Trash2 />
                          删除
                        </Button>
                      </span>
                    </div>
                    <div className='grid gap-2 sm:grid-cols-2'>
                      <div className='grid gap-2'>
                        <Label htmlFor={`target-group-${index}`}>平台组</Label>
                        <GroupPicker
                          id={`target-group-${index}`}
                          value={target.groupName}
                          onChange={(value) =>
                            patchTarget(index, {
                              groupName: value,
                              // 换了组，上一个组的模型 id 就不再作数。
                              upstreamModel: '',
                            })
                          }
                        />
                      </div>
                      <div className='grid gap-2'>
                        <Label htmlFor={`target-model-${index}`}>
                          平台模型 id
                        </Label>
                        <ModelPicker
                          id={`target-model-${index}`}
                          groupName={target.groupName}
                          value={target.upstreamModel}
                          takenModelIds={takenModelIds(index)}
                          onChange={(value) =>
                            patchTarget(index, { upstreamModel: value })
                          }
                        />
                      </div>
                    </div>
                    {duplicated.has(index) ? (
                      <p className='text-xs text-destructive'>
                        {`${target.groupName.trim()} / ${target.upstreamModel.trim()} 已经有一行了（第 ${(duplicated.get(index) ?? 0) + 1} 个目标）`}
                      </p>
                    ) : null}
                    {!targetFilled(target) ? (
                      <p className='text-xs text-destructive'>
                        这一行还没填全：平台组和平台模型 id 都要填。
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            <Button
              variant='outline'
              size='sm'
              className='w-fit'
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  targets: [...prev.targets, emptyTarget()],
                }))
              }
            >
              <Plus />
              加一个目标
            </Button>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={() => onSubmit(fromDraft(draft))}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 分组标题上的小红点：那个分组里有必填项没填。
 */
function RequiredDot() {
  return (
    <span
      aria-hidden='true'
      className={cn(
        'ms-1.5 inline-block size-1.5 rounded-full bg-destructive align-middle'
      )}
    />
  )
}

function InheritToggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label htmlFor={id} className='flex items-center gap-2 text-xs'>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  )
}
