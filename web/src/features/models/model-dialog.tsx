import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
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
import { cn } from '@/lib/utils'

/**
 * 三个取值：继承上游的、自己指定开、自己指定关。
 *
 * 契约里上下文长度、输出上限、是否思考、是否工具都是 optional 的：
 * 不给就是继承目标的值，给了就是用这个值。以前面板把它们当普通值处理，
 * 编辑一次就把「继承」写死成了具体数字。
 */
export type TriState = 'inherit' | 'yes' | 'no'

export type ModelDraft = {
  id: string
  displayName: string
  enabled: boolean
  strategy: string
  contextWindow: string
  contextWindowInherit: boolean
  maxOutputTokens: string
  maxOutputTokensInherit: boolean
  reasoning: TriState
  toolCall: TriState
  effortOptions: string
  targets: {
    groupName: string
    upstreamModel: string
    weight: string
    enabled: boolean
  }[]
}

function emptyTarget() {
  return {
    groupName: '',
    upstreamModel: '',
    weight: '1',
    enabled: true,
  }
}

/** 一行的目标填全了没有。 */
function targetFilled(target: ModelDraft['targets'][number]): boolean {
  return target.groupName.trim() !== '' && target.upstreamModel.trim() !== ''
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
    contextWindow:
      model.contextWindow === undefined ? '' : String(model.contextWindow),
    contextWindowInherit: model.contextWindow === undefined,
    maxOutputTokens:
      model.maxOutputTokens === undefined
        ? ''
        : String(model.maxOutputTokens),
    maxOutputTokensInherit: model.maxOutputTokens === undefined,
    reasoning: toTriState(model.reasoning),
    toolCall: toTriState(model.toolCall),
    effortOptions: model.effortOptions.join(', '),
    targets: model.targets.map((target) => ({
      groupName: target.groupName,
      upstreamModel: target.upstreamModel,
      weight: String(target.weight || 1),
      enabled: target.enabled,
    })),
  }
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
    targets: draft.targets
      .filter(targetFilled)
      .map(
        (target): PublishedTarget => ({
          ...create(PublishedTargetSchema),
          groupName: target.groupName.trim(),
          upstreamModel: target.upstreamModel.trim(),
          // single 策略不看权重：只走权重最大的那一个（权重一样就按顺序）。
          // 草稿里残留的权重不带进请求，统一发 1。
          weight:
            draft.strategy === 'fallback'
              ? Number(target.weight) || 1
              : 1,
          enabled: target.enabled,
          // requests / failed 是网关的计数，只读：保存时会被覆盖。
          requests: 0n,
          failed: 0n,
        })
      ),
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

  // 按填全了的目标数算，不是按行数：没填全的行会被过滤掉，拿行数算会
  // 放行一个「发出去是空 targets」的请求。
  const filledTargets = draft.targets.filter(targetFilled)

  // 哪个分组里有没填的必填项：分组标题上标红，切过去给行内提示。
  const basicMissing = draft.id.trim().length === 0
  const targetsMissing = filledTargets.length === 0

  const valid = !basicMissing && !targetsMissing

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {model ? '改主路由模型' : '新建一个主路由模型'}
          </DialogTitle>
          <DialogDescription>
            对外公布一个 id，背后挂几个上游模型。single 是只走一个目标，
            fallback 是它挂了再换下一个（按权重从大到小）。
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value='basic'>
              基本
              {basicMissing ? <RequiredDot /> : null}
            </TabsTrigger>
            <TabsTrigger value='targets'>
              Provider 目标
              {targetsMissing ? <RequiredDot /> : null}
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
                  对外 id 是必填的：客户端只认这个 id。
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
                  placeholder={
                    draft.contextWindowInherit ? '继承上游' : '留空 = 继承上游'
                  }
                  value={draft.contextWindow}
                  onChange={(event) =>
                    patch({ contextWindow: event.target.value })
                  }
                />
                <InheritToggle
                  id='model-ctx-inherit'
                  label='继承上游'
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
                  placeholder={
                    draft.maxOutputTokensInherit ? '继承上游' : '留空 = 继承上游'
                  }
                  value={draft.maxOutputTokens}
                  onChange={(event) =>
                    patch({ maxOutputTokens: event.target.value })
                  }
                />
                <InheritToggle
                  id='model-out-inherit'
                  label='继承上游'
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
                    <SelectItem value='inherit'>继承上游</SelectItem>
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
                    <SelectItem value='inherit'>继承上游</SelectItem>
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
                至少要有一个填全的目标：Provider 组和上游模型 id 都要填。
              </p>
            ) : null}
            {draft.targets.map((target, index) => (
              <div
                key={index}
                className='grid gap-2 rounded-lg border p-3 sm:grid-cols-2'
              >
                <div className='grid gap-2'>
                  <Label htmlFor={`target-group-${index}`}>Provider 组</Label>
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
                  <Label htmlFor={`target-model-${index}`}>上游模型 id</Label>
                  <ModelPicker
                    id={`target-model-${index}`}
                    groupName={target.groupName}
                    value={target.upstreamModel}
                    onChange={(value) =>
                      patchTarget(index, { upstreamModel: value })
                    }
                  />
                </div>
                {/* 权重只有 fallback 用得上：single 只走一个目标，权重没意义，
                    整块藏掉（不是禁用）。 */}
                {draft.strategy === 'fallback' ? (
                  <div className='grid gap-2'>
                    <Label htmlFor={`target-weight-${index}`}>权重</Label>
                    <Input
                      id={`target-weight-${index}`}
                      inputMode='numeric'
                      value={target.weight}
                      onChange={(event) =>
                        patchTarget(index, { weight: event.target.value })
                      }
                    />
                    <p className='text-xs text-muted-foreground'>
                      权重大的先试，失败了才试小的。
                    </p>
                  </div>
                ) : null}
                {!targetFilled(target) ? (
                  <p className='text-xs text-destructive sm:col-span-2'>
                    这一行还没填全：Provider 组和上游模型 id 都要填。
                  </p>
                ) : null}
                <div className='flex items-center justify-between gap-2 sm:col-span-2'>
                  <label className='flex items-center gap-2 text-sm'>
                    <Switch
                      checked={target.enabled}
                      onCheckedChange={(checked) =>
                        patchTarget(index, { enabled: checked })
                      }
                    />
                    启用这个目标
                  </label>
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        targets: prev.targets.filter((_, i) => i !== index),
                      }))
                    }
                    disabled={draft.targets.length === 1}
                  >
                    <Trash2 />
                    删掉
                  </Button>
                </div>
              </div>
            ))}
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
