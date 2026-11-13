import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import type { ModelBilling } from '@/gen/buddy/admin/v1/admin_pb'
import { billingLine } from './model-billing'
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
  splitLevels,
  touchField,
  withId,
  type EditableText,
  type ModelRow,
  type ProblemField,
  type ThinkingMode,
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
  /**
   * 这一轮开窗里已经因为「目录里没这条」重取过的 id。
   *
   * 档位只听目录的：要摆的那几档从目录现取。目录里压根没这个模型时（人工加的
   * 一条，或者目录还是上次那份），就重取一次；一个 id 只取一次，不跟着渲染转圈。
   */
  const refetched = useRef<Set<string>>(new Set())

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
    refetched.current.clear()
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

  /**
   * 要摆档位、而目录里没有这一行这个模型：重取一次目录。
   *
   * 上面那个 effect 只看 catalog.data 换来摆行，这里看的则是「这一行要的档位目录
   * 里没有」—— 不拿行上存的文本完事。一个 id 一次开窗只取一次。
   */
  useEffect(() => {
    if (!open) return
    const target = (rows ?? []).find((item) => item.key === selected)
    if (!target || target.thinking !== 'levels') return
    const id = target.id.trim()
    const known = (catalog.data?.models ?? []).some((item) => item.id === id)
    if (id === '' || known || refetched.current.has(id)) return
    refetched.current.add(id)
    void catalog.refetch()
  }, [open, rows, selected, catalog])

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
  /** 目录里现在这份（每次渲染现成的那份，不存副本）。 */
  const catalogModels = catalog.data?.models ?? []
  /**
   * 目录里那条模型报的档位。
   *
   * 每次现取：不把这个列表写进这一行的文本当成唯一来源 —— 目录里那份才是真的，
   * 一旦目录改了（或者这一行换了模型），摆出来的就是新的。
   */
  const levelsOf = (id: string): string[] =>
    catalogModels.find((item) => item.id === id.trim())?.effortOptions ?? []
  /**
   * 目录里那条模型报的计费（上游自己在 /models 里报的那份）。
   *
   * 跟下面「倍率」那一格的人工覆盖值是两回事：这一份只读，改了也不发请求。
   */
  const billingOf = (id: string): ModelBilling | undefined =>
    catalogModels.find((item) => item.id === id.trim())?.billing
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

  const patchText = (field: EditableText, value: string) =>
    patch((target) => ({
      ...target,
      text: { ...target.text, [field]: value },
      touched: touchField(target.touched, field),
    }))

  const patchToolCall = (value: TriState) =>
    patch((target) => ({
      ...target,
      toolCall: value,
      touched: touchField(target.touched, 'toolCall'),
    }))

  /**
   * 改「是否支持 thinking」那一格。
   *
   * 选到「档位可选」时要把档位摆出来：那几档现从目录里按 id 取（`levelsOf`），
   * 不拿这一行上一回留下的那串文本 —— 目录里没报档位才用这一行自己的（人工写在
   * 自定义条目里的那几档）。
   */
  const patchThinking = (value: ThinkingMode) =>
    patch((target) => {
      const fromCatalog = levelsOf(target.id)
      const tiers =
        fromCatalog.length > 0
          ? fromCatalog
          : splitLevels(target.text.effortOptions)
      return {
        ...target,
        thinking: value,
        text:
          value === 'levels'
            ? { ...target.text, effortOptions: tiers.join(', ') }
            : target.text,
        touched: touchField(target.touched, 'thinking'),
      }
    })

  /** 勾上的那几档。勾选归在 `thinking` 这一格：契约里它跟 reasoning 是一件事。 */
  const patchEfforts = (levels: string[]) =>
    patch((target) => ({
      ...target,
      text: { ...target.text, effortOptions: levels.join(', ') },
      touched: touchField(target.touched, 'thinking'),
    }))

  /** 目录没报档位时自己填的那一串原文（原样留着，不在敲的时候拆）。 */
  const patchEffortsText = (value: string) =>
    patch((target) => ({
      ...target,
      text: { ...target.text, effortOptions: value },
      touched: touchField(target.touched, 'thinking'),
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
                catalogLevels={levelsOf(draft?.id ?? row.id)}
                billing={billingOf(draft?.id ?? row.id)}
                problemId={(field) => problemIds.get(field)}
                onChangeText={patchText}
                onChangeToolCall={patchToolCall}
                onChangeThinking={patchThinking}
                onChangeEfforts={patchEfforts}
                onChangeEffortsText={patchEffortsText}
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
  catalogLevels,
  billing,
  problemId,
  onChangeText,
  onChangeToolCall,
  onChangeThinking,
  onChangeEfforts,
  onChangeEffortsText,
}: {
  row: ModelRow
  /** 目录里这条模型报的档位。空 = 目录没报，这一格退回自己填。 */
  catalogLevels: string[]
  /** 目录里这条模型报的计费。写不成一句话就什么都不摆（见 billingLine）。 */
  billing: ModelBilling | undefined
  /** 这一格的错误在界面上的位置：传给 aria-describedby。 */
  problemId: (field: ProblemField) => string | undefined
  onChangeText: (field: EditableText, value: string) => void
  onChangeToolCall: (value: TriState) => void
  onChangeThinking: (value: ThinkingMode) => void
  onChangeEfforts: (levels: string[]) => void
  onChangeEffortsText: (value: string) => void
}) {
  // 哪几格现在有毛病：标红并指到下面那句话。
  const contextProblem = problemId('contextWindow')
  const outputProblem = problemId('maxOutputTokens')
  const creditsProblem = problemId('credits')
  const effortProblem = problemId('effortOptions')
  /** 上游报的计费，一行；写不出来时是 `null`。 */
  const billingText = billingLine(billing)

  /** 现在勾着的档位（原文就是逗号分隔的那一串）。 */
  const picked = splitLevels(row.text.effortOptions)
  const pickedSet = new Set(picked)
  // 摆出来的是目录报的那几档；人工写下的档位不在目录里也摆出来 —— 不然它们
  // 看不见，也就勾不掉、发不回去。目录一档都没报时才是「自己填」（见下面）。
  const levelOptions =
    catalogLevels.length > 0
      ? [
          ...catalogLevels,
          ...picked.filter((level) => !catalogLevels.includes(level)),
        ]
      : []
  /** 勾上 / 取消一档：按摆出来的顺序重新写一遍，不是就着原来的字符串改。 */
  const toggle = (level: string, on: boolean) =>
    onChangeEfforts(
      levelOptions.filter((item) =>
        item === level ? on : pickedSet.has(item)
      )
    )

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
            value={row.text.credits}
            onChange={(event) => onChangeText('credits', event.target.value)}
          />
        </div>
      </div>

      {/* 上游报的那份只读摆出来，跟上面人工填的「倍率」分开：两者不合并、不互算。 */}
      {billingText === null ? null : (
        <p className='text-sm text-muted-foreground'>
          <span className='me-1 text-xs'>上游报价</span>
          {billingText}
        </p>
      )}

      <div className='grid gap-2 sm:grid-cols-2'>
        <div className='grid gap-1'>
          <Label htmlFor='model-thinking'>是否支持 thinking</Label>
          <Select
            // `unset`（人工新填的一条，目录里没有它）摆成「不支持 thinking」：
            // 没动过就不写进人工条目，用户选了才真写下去。
            value={row.thinking === 'unset' ? 'none' : row.thinking}
            onValueChange={(value) =>
              onChangeThinking(value as ThinkingMode)
            }
          >
            <SelectTrigger
              id='model-thinking'
              aria-label='是否支持 thinking'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='none'>不支持 thinking</SelectItem>
              <SelectItem value='fixed'>固定档位</SelectItem>
              <SelectItem value='levels'>档位可选</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='grid gap-1'>
          <Label htmlFor='model-tool-call'>是否支持 Tool Call</Label>
          <Select
            value={row.toolCall}
            onValueChange={(value) => onChangeToolCall(value as TriState)}
          >
            <SelectTrigger
              id='model-tool-call'
              aria-label='是否支持 Tool Call'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='inherit'>用原来的值</SelectItem>
              <SelectItem value='yes'>是</SelectItem>
              <SelectItem value='no'>否</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 不支持 thinking 的时候，档位这一块（包括自己填）整块不摆。 */}
      {row.thinking === 'levels' ? (
        <div className='grid gap-1'>
          {levelOptions.length > 0 ? (
            <>
              <Label>可选档位</Label>
              <div
                role='group'
                aria-label='可选档位'
                aria-invalid={effortProblem ? true : undefined}
                aria-describedby={effortProblem}
                className='flex flex-wrap gap-x-4 gap-y-2'
              >
                {levelOptions.map((level) => (
                  <label
                    key={level}
                    className='flex items-center gap-1.5 text-sm'
                  >
                    <Checkbox
                      aria-label={level}
                      checked={pickedSet.has(level)}
                      onCheckedChange={(value) => toggle(level, value === true)}
                    />
                    <span className='font-mono'>{level}</span>
                  </label>
                ))}
              </div>
              <p className='text-xs text-muted-foreground'>档位来自模型目录</p>
            </>
          ) : (
            <>
              <Label htmlFor='model-efforts'>可选档位</Label>
              <Input
                id='model-efforts'
                aria-label='可选档位'
                aria-invalid={effortProblem ? true : undefined}
                aria-describedby={effortProblem}
                placeholder='逗号分隔，比如 low, high'
                value={row.text.effortOptions}
                onChange={(event) => onChangeEffortsText(event.target.value)}
              />
              <p className='text-xs text-muted-foreground'>
                目录没报这个模型的档位，自己填
              </p>
            </>
          )}
        </div>
      ) : null}
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
