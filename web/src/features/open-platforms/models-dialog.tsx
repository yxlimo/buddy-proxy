import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'
import { Badge } from '@/components/ui/badge'
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
import { useCatalogModels } from '@/features/models/catalog-api'
import { describeError } from '@/lib/errors'
import { useModelOverrides, useSetModelOverrides } from './api'
import {
  dropOverride,
  listProblems,
  modelRows,
  newRow,
  overridesFromRows,
  touchField,
  type ModelRow,
  type EffortMode,
  type OverrideField,
  type ProblemField,
  type TextField,
  type TriState,
} from './model-overrides'

/**
 * 弹窗里那两份数据的四档：还在加载、取不到（带原因）、到手。
 *
 * 两份都要到手才能改：只拿到目录的话，人工那部分里哪些格是改过的就说不准，
 * 保存会把它们一起抹掉。
 */
type ModelData =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready' }

/**
 * 「自定义模型」弹窗：改目录里那些模型的元数据，也可以自己加一个模型 id。
 *
 * 保存发的是整份人工条目（SetModelOverrides 是整体替换），但里面每一条只写
 * 「这一轮改过的格」—— 见 model-overrides.ts。所以什么都没改就保存，发上去的是
 * 空列表，目录里的模型不会被写成人工作品。
 */
export function PlatformModelsDialog({
  open,
  platform,
  onOpenChange,
}: {
  open: boolean
  platform: Upstream
  onOpenChange: (open: boolean) => void
}) {
  const platformId = platform.id
  // 关着的时候不取：弹窗是常驻组件，不该在后台发请求。
  const catalog = useCatalogModels(open ? platformId : '', platform.state)
  const overrides = useModelOverrides(open ? platformId : '')
  const save = useSetModelOverrides()
  /** 弹窗里的那几行。`null` 表示还没从服务端那两份摆出来。 */
  const [rows, setRows] = useState<ModelRow[] | null>(null)

  useEffect(() => {
    // 每次打开都从服务端那两份重新摆：上一次改到一半关掉的不留着。
    // mutation 的对象每次渲染都是新的，所以只看 open。
    if (open) save.reset()
    setRows(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open || rows !== null) return
    if (catalog.data === undefined || overrides.data === undefined) return
    // 摆一次：之后的改动都在 rows 里，后台重取回来了也不动它。
    setRows(modelRows(catalog.data.models, overrides.data.overrides))
  }, [open, rows, catalog.data, overrides.data])

  const data: ModelData =
    catalog.isPending || overrides.isPending
      ? { status: 'loading' }
      : catalog.isError
        ? {
            status: 'failed',
            message: `模型目录取不到：${describeError(catalog.error)}`,
          }
        : overrides.isError
          ? {
              status: 'failed',
              message: `自定义那部分取不到：${describeError(overrides.error)}`,
            }
          : { status: 'ready' }

  const list = rows ?? []
  const problems = listProblems(list)
  // 每一行每一格该指向哪一条错误：`${行}:${格}` → 那条错误的 DOM id。
  const problemIds = new Map<string, string>()
  problems.forEach((problem, index) => {
    const domId = `model-problem-${index}`
    for (const rowIndex of problem.rowIndexes) {
      const key = `${rowIndex}:${problem.field}`
      const known = problemIds.get(key)
      problemIds.set(key, known ? `${known} ${domId}` : domId)
    }
  })
  const saving = save.isPending
  const saveDisabled =
    data.status !== 'ready' || rows === null || problems.length > 0 || saving

  const patchText = (index: number, field: TextField, value: string) =>
    setRows((prev) =>
      (prev ?? []).map((row, i) =>
        i === index
          ? {
              ...row,
              text: { ...row.text, [field]: value },
              touched: touchField(row.touched, field),
            }
          : row
      )
    )

  const patchTri = (index: number, field: OverrideField, value: TriState) =>
    setRows((prev) =>
      (prev ?? []).map((row, i) =>
        i === index
          ? {
              ...row,
              reasoning: field === 'reasoning' ? value : row.reasoning,
              toolCall: field === 'toolCall' ? value : row.toolCall,
              touched: touchField(row.touched, field),
            }
          : row
      )
    )

  const patchEffort = (index: number, value: EffortMode) =>
    setRows((prev) =>
      (prev ?? []).map((row, i) =>
        i === index
          ? {
              ...row,
              effortMode: value,
              touched: touchField(row.touched, 'effortOptions'),
            }
          : row
      )
    )

  const patchId = (index: number, value: string) =>
    setRows((prev) =>
      (prev ?? []).map((row, i) => (i === index ? { ...row, id: value } : row))
    )

  const removeRow = (index: number) =>
    setRows((prev) =>
      (prev ?? []).flatMap((row, i) =>
        i === index ? dropOverride(row, catalog.data?.models ?? []) : [row]
      )
    )

  const submit = () => {
    if (rows === null) return
    save.mutate(
      { platformId, overrides: overridesFromRows(rows) },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            自定义模型 · {platform.label || platform.id}
          </DialogTitle>
          <DialogDescription>
            改过的格子存下来，没改的格子不动
          </DialogDescription>
        </DialogHeader>

        {data.status === 'loading' ? (
          <p className='py-8 text-center text-sm text-muted-foreground'>
            正在取模型目录与自定义那部分
          </p>
        ) : data.status === 'failed' ? (
          <div className='grid justify-items-center gap-2 py-8'>
            <p role='alert' className='text-sm text-destructive'>
              {data.message}
            </p>
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                void catalog.refetch()
                void overrides.refetch()
              }}
            >
              重试
            </Button>
          </div>
        ) : (
          <div className='grid gap-3'>
            <div className='flex items-start justify-between gap-3'>
              <p className='text-xs text-muted-foreground'>
                删掉后目录里本来就有的回到目录的值，自己加的从列表去掉
              </p>
              <Button
                size='sm'
                variant='outline'
                onClick={() =>
                  setRows((prev) => [...(prev ?? []), newRow()])
                }
              >
                <Plus />
                加模型
              </Button>
            </div>

            <div
              role='group'
              aria-label='模型列表'
              className='grid max-h-[52vh] gap-2 overflow-y-auto'
            >
              {list.length === 0 ? (
                <p className='py-6 text-center text-sm text-muted-foreground'>
                  目录里还没有模型
                </p>
              ) : null}
              {list.map((row, index) => (
                <ModelRowFields
                  key={row.key}
                  index={index}
                  row={row}
                  problemId={(field) =>
                    problemIds.get(`${index}:${field}`)
                  }
                  onChangeText={(field, value) =>
                    patchText(index, field, value)
                  }
                  onChangeTri={(field, value) => patchTri(index, field, value)}
                  onChangeEffort={(value) => patchEffort(index, value)}
                  onChangeId={(value) => patchId(index, value)}
                  onRemove={() => removeRow(index)}
                />
              ))}
            </div>

            {problems.length > 0 ? (
              <ul role='alert' className='grid gap-0.5 text-sm text-destructive'>
                {problems.map((problem, index) => (
                  <li key={problem.text} id={`model-problem-${index}`}>
                    {problem.text}
                  </li>
                ))}
              </ul>
            ) : null}

            {save.error ? (
              <p role='alert' className='text-sm text-destructive'>
                {describeError(save.error)}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={saveDisabled} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 一行：模型 id 与它的那几格。 */
function ModelRowFields({
  index,
  row,
  problemId,
  onChangeText,
  onChangeTri,
  onChangeEffort,
  onChangeId,
  onRemove,
}: {
  index: number
  row: ModelRow
  /** 这一格的错误在界面上的位置：传给 aria-describedby。 */
  problemId: (field: ProblemField) => string | undefined
  onChangeText: (field: TextField, value: string) => void
  onChangeTri: (field: OverrideField, value: TriState) => void
  onChangeEffort: (value: EffortMode) => void
  onChangeId: (value: string) => void
  onRemove: () => void
}) {
  // 人工那部分里有它：要么是人工加的，要么写着人的值。
  const manual = row.added || row.saved !== undefined || row.touched.length > 0
  const fieldId = (name: string) => `model-${index}-${name}`
  // 哪几格现在有毛病：标红并指到下面那句话。
  const idProblem = problemId('id')
  const contextProblem = problemId('contextWindow')
  const outputProblem = problemId('maxOutputTokens')
  const creditsProblem = problemId('credits')
  const effortProblem = problemId('effortOptions')

  return (
    <div
      role='group'
      aria-label={row.id || `新模型 ${index + 1}`}
      className='grid gap-2 rounded-md border p-3'
    >
      <div className='flex items-center gap-2'>
        {row.added ? (
          <Input
            aria-label='模型 id'
            aria-invalid={idProblem ? true : undefined}
            aria-describedby={idProblem}
            className='h-7 max-w-64 font-mono text-xs'
            placeholder='模型 id'
            value={row.id}
            onChange={(event) => onChangeId(event.target.value)}
          />
        ) : (
          <span className='font-mono text-sm'>{row.id}</span>
        )}
        {manual ? <Badge variant='secondary'>已改</Badge> : null}
        <span className='grow' />
        {manual ? (
          <Button
            size='xs'
            variant='outline'
            className='text-destructive'
            aria-label={`删掉 ${row.id || '这个模型'}`}
            onClick={onRemove}
          >
            删掉
          </Button>
        ) : null}
      </div>

      <div className='grid gap-2 sm:grid-cols-2'>
        <div className='grid gap-1'>
          <Label htmlFor={fieldId('display-name')}>显示名</Label>
          <Input
            id={fieldId('display-name')}
            value={row.text.displayName}
            onChange={(event) =>
              onChangeText('displayName', event.target.value)
            }
          />
        </div>
        <div className='grid gap-1'>
          <Label htmlFor={fieldId('context')}>上下文</Label>
          <Input
            id={fieldId('context')}
            inputMode='numeric'
            aria-invalid={contextProblem ? true : undefined}
            aria-describedby={contextProblem}
            value={row.text.contextWindow}
            onChange={(event) =>
              onChangeText('contextWindow', event.target.value)
            }
          />
        </div>
        <div className='grid gap-1'>
          <Label htmlFor={fieldId('output')}>输出上限</Label>
          <Input
            id={fieldId('output')}
            inputMode='numeric'
            aria-invalid={outputProblem ? true : undefined}
            aria-describedby={outputProblem}
            value={row.text.maxOutputTokens}
            onChange={(event) =>
              onChangeText('maxOutputTokens', event.target.value)
            }
          />
        </div>
        <div className='grid gap-1'>
          <Label htmlFor={fieldId('credits')}>倍率</Label>
          <Input
            id={fieldId('credits')}
            inputMode='decimal'
            aria-invalid={creditsProblem ? true : undefined}
            aria-describedby={creditsProblem}
            placeholder='没报'
            value={row.text.credits}
            onChange={(event) => onChangeText('credits', event.target.value)}
          />
        </div>
      </div>

      <div className='grid gap-2 sm:grid-cols-2'>
        <div className='grid gap-1'>
          <Label htmlFor={fieldId('reasoning')}>是否推理</Label>
          <Select
            value={row.reasoning}
            onValueChange={(value) =>
              onChangeTri('reasoning', value as TriState)
            }
          >
            <SelectTrigger id={fieldId('reasoning')} aria-label='是否推理'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='inherit'>用原来的值</SelectItem>
              <SelectItem value='yes'>是</SelectItem>
              <SelectItem value='no'>否</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='grid gap-1'>
          <Label htmlFor={fieldId('tool-call')}>是否工具</Label>
          <Select
            value={row.toolCall}
            onValueChange={(value) =>
              onChangeTri('toolCall', value as TriState)
            }
          >
            <SelectTrigger id={fieldId('tool-call')} aria-label='是否工具'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='inherit'>用原来的值</SelectItem>
              <SelectItem value='yes'>是</SelectItem>
              <SelectItem value='no'>否</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='grid gap-1'>
          <Label htmlFor={fieldId('effort-mode')}>档位模式</Label>
          <Select
            value={row.effortMode}
            onValueChange={(value) => onChangeEffort(value as EffortMode)}
          >
            <SelectTrigger
              id={fieldId('effort-mode')}
              aria-label='档位模式'
              aria-invalid={effortProblem ? true : undefined}
              aria-describedby={effortProblem}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='inherit'>不设置</SelectItem>
              <SelectItem value='none'>不能选档</SelectItem>
              <SelectItem value='levels'>指定档位</SelectItem>
            </SelectContent>
          </Select>
          {row.effortMode === 'levels' ? (
            <>
              <Label htmlFor={fieldId('efforts')}>可选档位</Label>
              <Input
                id={fieldId('efforts')}
                aria-label='可选档位'
                aria-invalid={effortProblem ? true : undefined}
                aria-describedby={effortProblem}
                placeholder='逗号分隔，比如 low, high'
                value={row.text.effortOptions}
                onChange={(event) =>
                  onChangeText('effortOptions', event.target.value)
                }
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * 平台卡片上那个入口。
 *
 * 所有平台都有这一份（模板平台的目录在代码里，也能被它补上）。它自己拿弹窗的
 * 开关，父组件不用记「现在开的是哪个平台」。
 */
export function PlatformModelsButton({ platform }: { platform: Upstream }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size='sm' variant='outline' onClick={() => setOpen(true)}>
        自定义模型
      </Button>
      <PlatformModelsDialog
        open={open}
        platform={platform}
        onOpenChange={setOpen}
      />
    </>
  )
}
