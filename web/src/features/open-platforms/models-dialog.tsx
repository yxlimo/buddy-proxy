import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'
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
import {
  useDeleteModelOverride,
  useModelOverrides,
  useSetModelOverrides,
} from './api'
import {
  changedFields,
  dropOverride,
  idChanged,
  listProblems,
  modelRows,
  newRow,
  overridesFromRows,
  touchField,
  withId,
  type EffortMode,
  type ModelRow,
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
 * 「自定义模型」弹窗：一次改一条。
 *
 * 上面那个下拉里列着这个平台现有的全部模型（目录里原有的与人工加的都在，
 * 落过自定义的那几条带「已改」），选一条、下面只摆它那一套格子。点「新增模型」
 * 换成手填一个 id，填成下拉里已有的那条等于选它，不另造一行。
 *
 * 保存只发当前这一条：SetModelOverrides 按 id 覆盖，没发来的条目原封不动。
 * 一格都没改（id 也没改）就不发请求 —— 判据是 `changedFields` 与 `idChanged`。
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
  const remove = useDeleteModelOverride()
  /** 弹窗里的那几条。`null` 表示还没从服务端那两份摆出来。 */
  const [rows, setRows] = useState<ModelRow[] | null>(null)
  /**
   * 刚进来时的那一份，按行的键记。
   *
   * 保存前跟它逐格比：一格都没差就不发请求。它不跟着编辑走 —— 编辑改的是
   * `rows`，这一份留着当基准。
   */
  const [pristine, setPristine] = useState<Record<string, ModelRow>>({})
  /** 现在改的是哪一条（`ModelRow.key`）。 */
  const [selected, setSelected] = useState('')
  /**
   * 手填那一格的原文。
   *
   * 不直接读选中的那一行的 id：用户敲到一半的 id 还不是任何一条模型，写进行里
   * 就等于当场多出一条、还会在下拉里冒出来。敲完了（保存时）才算。
   */
  const [idText, setIdText] = useState('')

  useEffect(() => {
    // 每次打开都从服务端那两份重新摆：上一次改到一半关掉的不留着。
    // mutation 的对象每次渲染都是新的，所以只看 open。
    if (open) {
      save.reset()
      remove.reset()
    }
    setRows(null)
    setPristine({})
    setSelected('')
    setIdText('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open || rows !== null) return
    if (catalog.data === undefined || overrides.data === undefined) return
    // 摆一次：之后的改动都在 rows 里，后台重取回来了也不动它。
    const built = modelRows(catalog.data.models, overrides.data.overrides)
    // 一条也没有：摆一行空的，直接敲 id 就能加，不用先点「新增模型」。
    const list = built.length > 0 ? built : [newRow()]
    setRows(list)
    setPristine(Object.fromEntries(list.map((row) => [row.key, row])))
    setSelected(list[0].key)
    setIdText(list[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const index = list.findIndex((row) => row.key === selected)
  const row = index >= 0 ? list[index] : undefined
  /** 选中的这一条刚进来时的样子：保存前跟它比。 */
  const base = row ? pristine[row.key] : undefined
  /** 下拉里列着的那几条：有 id 的那些。刚敲出来还没填 id 的那一行不在里面。 */
  const listed = list.filter((item) => item.id.trim() !== '')
  /** 现在是「从列表里选一条」还是「手填一个新 id」：选中的那条还没有 id 就是手填。 */
  const picking = row !== undefined && row.id.trim() !== ''
  /**
   * 这一条要存成什么。
   *
   * id 跟刚进来时不一样，就是「照这条再建一条」：`withId` 把现在看得见的那几格
   * 写成这一条自己的值，原来那条人工条目不再跟着走。
   */
  const draft =
    row && base && idText.trim() !== base.id.trim()
      ? withId(row, idText, base)
      : row
  // 校验拿 `draft` 去：id 敲到一半也要先说清，别等保存了才报。
  const checking = draft
    ? list.map((item, at) => (at === index ? draft : item))
    : list
  const problems = draft
    ? listProblems(checking).filter((problem) =>
        problem.rowIndexes.includes(index)
      )
    : []
  // 每一格该指向哪一条错误。
  const problemIds = new Map<ProblemField, string>()
  problems.forEach((problem, at) => {
    problemIds.set(problem.field, `model-problem-${at}`)
  })
  /** 有没有改动：id 或那几格有一处不一样，保存才有意义。 */
  const dirty =
    draft !== undefined &&
    base !== undefined &&
    (idChanged(draft, base) || changedFields(draft, base).length > 0)
  const saving = save.isPending
  const removing = remove.isPending
  const saveDisabled =
    data.status !== 'ready' ||
    draft === undefined ||
    problems.length > 0 ||
    saving ||
    removing ||
    !dirty
  // 库里有这一条人工条目，或者是刚敲出来的新的一条：前一种发删除请求，后一种
  // 只把界面这一行拿掉。
  const removable =
    row !== undefined &&
    base !== undefined &&
    (base.saved !== undefined || row.added)

  /** 改的那几格都写在选中的这一行上（不是按列表下标找：选中的那条换了位置也不串）。 */
  const patch = (change: (target: ModelRow) => ModelRow) =>
    setRows((prev) =>
      (prev ?? []).map((item) => (item.key === selected ? change(item) : item))
    )

  /** 选中一条：id 那一格跟着换成它的 id。 */
  const pick = (key: string) => {
    const target = list.find((item) => item.key === key)
    setSelected(key)
    setIdText(target?.id ?? '')
    // 刚敲出来又换走的空行：它只因为要加一条才在，别留着占位置。
    setRows((prev) =>
      (prev ?? []).filter((item) => item.key === key || item.id.trim() !== '')
    )
  }

  const patchText = (field: TextField, value: string) =>
    patch((target) => ({
      ...target,
      text: { ...target.text, [field]: value },
      touched: touchField(target.touched, field),
    }))

  const patchTri = (field: OverrideField, value: TriState) =>
    patch((target) => ({
      ...target,
      reasoning: field === 'reasoning' ? value : target.reasoning,
      toolCall: field === 'toolCall' ? value : target.toolCall,
      touched: touchField(target.touched, field),
    }))

  const patchEffort = (value: EffortMode) =>
    patch((target) => ({
      ...target,
      effortMode: value,
      touched: touchField(target.touched, 'effortOptions'),
    }))

  /**
   * 改 id 那一格。
   *
   * 敲成现有某个模型的 id（不是选中这条）就转到那一条去；敲成别的，就把字先留在
   * 这一格上 —— 保存时才算成新的一条（字段照现在这条复制）。
   */
  const patchId = (value: string) => {
    const hit = list.find(
      (item) =>
        item.key !== selected &&
        item.id.trim() !== '' &&
        item.id.trim() === value.trim()
    )
    if (hit) {
      pick(hit.key)
      return
    }
    setIdText(value)
  }

  const addModel = () => {
    // 已经有一条等着填 id 的：转到那一条，不叠出第二条空行。
    const blank = list.find((item) => item.id.trim() === '')
    if (blank) {
      pick(blank.key)
      return
    }
    const fresh = newRow()
    setRows((prev) => [...(prev ?? []), fresh])
    setPristine((prev) => ({ ...prev, [fresh.key]: fresh }))
    setSelected(fresh.key)
    setIdText('')
  }

  const removeModel = () => {
    if (!row || !base) return
    const models = catalog.data?.models ?? []
    const apply = () => {
      const next = list.flatMap((item) =>
        item.key === row.key ? dropOverride(item, models) : item
      )
      setRows(next)
      setPristine((prev) => {
        const copy = { ...prev }
        delete copy[row.key]
        // 目录里本来就有的那一条：回到目录那份值，它就是新的基准。
        const reverted = next.find((item) => item.key === row.key)
        if (reverted) copy[row.key] = reverted
        return copy
      })
      // 删完选中前一条（没有就第一条）：不留一个空的编辑区。
      const target = next[Math.max(0, index - 1)] ?? next[0]
      setSelected(target?.key ?? '')
      setIdText(target?.id ?? '')
    }
    // 库里本来没有这一条：这是界面上刚敲出来的，不用问服务端。
    if (base.saved === undefined) {
      apply()
      return
    }
    remove.mutate({ platformId, modelId: base.id }, { onSuccess: apply })
  }

  const submit = () => {
    if (!draft) return
    save.mutate(
      { platformId, overrides: overridesFromRows([draft]) },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  const error = save.error ?? remove.error

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            自定义模型 · {platform.label || platform.id}
          </DialogTitle>
          <DialogDescription>
            选中一条改它，没改的格子不写进去
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
            <div className='grid gap-1'>
              <div className='flex items-baseline gap-2'>
                <Label htmlFor='model-id'>模型 id</Label>
                <span className='text-xs text-muted-foreground'>
                  共 {listed.length} 个模型
                </span>
              </div>
              <div className='flex items-center gap-2'>
                {picking ? (
                  <Select value={selected} onValueChange={pick}>
                    <SelectTrigger
                      id='model-id'
                      aria-label='模型 id'
                      aria-invalid={problemIds.has('id') ? true : undefined}
                      aria-describedby={problemIds.get('id')}
                      className='w-72 font-mono text-sm'
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {listed.map((item) => (
                        <SelectItem
                          key={item.key}
                          value={item.key}
                          aria-label={item.id}
                          className='font-mono text-sm'
                        >
                          {item.id}
                          {pristine[item.key]?.saved !== undefined ? (
                            <span
                              aria-hidden='true'
                              className='text-xs text-muted-foreground'
                            >
                              已改
                            </span>
                          ) : null}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id='model-id'
                    className='w-72 font-mono text-sm'
                    placeholder='新 id'
                    aria-invalid={problemIds.has('id') ? true : undefined}
                    aria-describedby={problemIds.get('id')}
                    value={idText}
                    onChange={(event) => patchId(event.target.value)}
                  />
                )}
                <Button size='sm' variant='outline' onClick={addModel}>
                  <Plus />
                  新增模型
                </Button>
                {removable ? (
                  <Button
                    size='sm'
                    variant='outline'
                    className='text-destructive'
                    aria-label={`删除 ${base?.id || row?.id || ''}`}
                    disabled={removing}
                    onClick={removeModel}
                  >
                    删除
                  </Button>
                ) : null}
              </div>
              {picking ? null : (
                <p className='text-xs text-muted-foreground'>
                  这个 id 还不在列表里，保存后加进目录
                </p>
              )}
            </div>

            {row && base ? (
              <ModelFields
                row={row}
                problemId={(field) => problemIds.get(field)}
                onChangeText={patchText}
                onChangeTri={patchTri}
                onChangeEffort={patchEffort}
              />
            ) : (
              <p className='py-6 text-center text-sm text-muted-foreground'>
                目录里还没有模型
              </p>
            )}

            {problems.length > 0 ? (
              <ul role='alert' className='grid gap-0.5 text-sm text-destructive'>
                {problems.map((problem, at) => (
                  <li key={problem.text} id={`model-problem-${at}`}>
                    {problem.text}
                  </li>
                ))}
              </ul>
            ) : null}

            {error ? (
              <p role='alert' className='text-sm text-destructive'>
                {describeError(error)}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {/* 没改动就不发请求：说一句，别让人对着一个灰按钮猜。 */}
          {data.status === 'ready' && !dirty ? (
            <p className='me-auto text-xs text-muted-foreground'>没有改动</p>
          ) : null}
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

/** 选中那一条的几格。 */
function ModelFields({
  row,
  problemId,
  onChangeText,
  onChangeTri,
  onChangeEffort,
}: {
  row: ModelRow
  /** 这一格的错误在界面上的位置：传给 aria-describedby。 */
  problemId: (field: ProblemField) => string | undefined
  onChangeText: (field: TextField, value: string) => void
  onChangeTri: (field: OverrideField, value: TriState) => void
  onChangeEffort: (value: EffortMode) => void
}) {
  // 哪几格现在有毛病：标红并指到下面那句话。
  const contextProblem = problemId('contextWindow')
  const outputProblem = problemId('maxOutputTokens')
  const creditsProblem = problemId('credits')
  const effortProblem = problemId('effortOptions')

  return (
    <div className='grid gap-2 rounded-md border p-3'>
      <div className='grid gap-2 sm:grid-cols-2'>
        <div className='grid gap-1'>
          <Label htmlFor='model-display-name'>显示名</Label>
          <Input
            id='model-display-name'
            value={row.text.displayName}
            onChange={(event) =>
              onChangeText('displayName', event.target.value)
            }
          />
        </div>
        <div className='grid gap-1'>
          <Label htmlFor='model-context'>上下文</Label>
          <Input
            id='model-context'
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
          <Label htmlFor='model-output'>输出上限</Label>
          <Input
            id='model-output'
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
          <Label htmlFor='model-credits'>倍率</Label>
          <Input
            id='model-credits'
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
          <Label htmlFor='model-reasoning'>是否推理</Label>
          <Select
            value={row.reasoning}
            onValueChange={(value) =>
              onChangeTri('reasoning', value as TriState)
            }
          >
            <SelectTrigger id='model-reasoning' aria-label='是否推理'>
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
          <Label htmlFor='model-tool-call'>是否工具</Label>
          <Select
            value={row.toolCall}
            onValueChange={(value) =>
              onChangeTri('toolCall', value as TriState)
            }
          >
            <SelectTrigger id='model-tool-call' aria-label='是否工具'>
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
          <Label htmlFor='model-effort-mode'>档位模式</Label>
          <Select
            value={row.effortMode}
            onValueChange={(value) => onChangeEffort(value as EffortMode)}
          >
            <SelectTrigger
              id='model-effort-mode'
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
              <Label htmlFor='model-efforts'>可选档位</Label>
              <Input
                id='model-efforts'
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
