import type {
  CatalogModel,
  ModelOverride,
} from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 「自定义模型」弹窗的纯逻辑：行怎么摆出来、保存时发什么。
 *
 * 保存（SetModelOverrides）是整体替换：发上去的那份就是人工那一份的全部，没发
 * 来的条目等于删掉。所以这里只做一件事 —— 每一行记着「这一轮改过哪几格」，
 * 发出去的时候只写改过的格：没改的格一写，代码/上游那份值就被固化成人工的了。
 */

/** 一行上能改的字段：与契约里 ModelOverride 那几格一一对应。 */
export type OverrideField =
  | 'displayName'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'reasoning'
  | 'toolCall'
  | 'effortOptions'
  | 'credits'

/** 要发上去的一条人工条目：除了 id，只带写着值的那几格。 */
export type OverrideInput = {
  id: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoning?: boolean
  toolCall?: boolean
  /** 没给这一格 = 没写；`levels` 空 = 这个模型明确不能选档。 */
  effortOptions?: { levels: string[] }
  credits?: number
}

/**
 * 「可选档位」这一格的三态。
 *
 * `inherit` 是「没写这一格」，沿用原来的档位；`none` 是「写了、一档都没有」——
 * 这个模型明确不能选档；`levels` 是写下的那几档。
 */
export type EffortMode = 'inherit' | 'none' | 'levels'

/** 输入框里那几格：值都是原文。空着表示「不写这一格」；档位这一格的空写成
 * 什么由 `EffortMode` 说。 */
export type TextField =
  | 'displayName'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'effortOptions'
  | 'credits'

/**
 * 三态的开关：`inherit` 是「用原来的值」—— 不写这一格，也就是不上人工值。
 *
 * 目录里那一条本来就带着布尔值，所以它的初值是 yes/no，不是 inherit。
 */
export type TriState = 'inherit' | 'yes' | 'no'

/** 弹窗里的一行：目录里的一条，或者人工加的一条。 */
export interface ModelRow {
  /**
   * 列表里那个稳定键。
   *
   * 不能用下标：删掉中间一行，后面每行的键都往前挪一位，输入框里正打着的字
   * 与焦点会落到别的模型上。
   */
  key: string
  id: string
  /** 目录里没有这一条：人工加的。 */
  added: boolean
  /** 输入框里的原文。 */
  text: Record<TextField, string>
  reasoning: TriState
  toolCall: TriState
  /** 档位这一格现在是哪一态（见 `EffortMode`）。 */
  effortMode: EffortMode
  /** 这一轮改过哪几格。没改的格不写进人工条目。 */
  touched: OverrideField[]
  /** 打开弹窗时已经写着的人工条目：用户没碰的格要原样带上去（整体替换）。 */
  saved?: OverrideInput
}

function emptyText(): Record<TextField, string> {
  return {
    displayName: '',
    contextWindow: '',
    maxOutputTokens: '',
    effortOptions: '',
    credits: '',
  }
}

/**
 * 服务端给的一条人工条目 → 只带写着值的那些格。
 *
 * 档位这一格要分两件事：`effort_options` 没给 = 没写；给了空列表 = 明确不能
 * 选档。两者都原样带到输入里。
 */
export function toOverrideInput(item: ModelOverride): OverrideInput {
  const input: OverrideInput = { id: item.id }
  if (item.displayName !== undefined && item.displayName !== '') {
    input.displayName = item.displayName
  }
  if (item.contextWindow !== undefined) {
    input.contextWindow = item.contextWindow
  }
  if (item.maxOutputTokens !== undefined) {
    input.maxOutputTokens = item.maxOutputTokens
  }
  if (item.reasoning !== undefined) input.reasoning = item.reasoning
  if (item.toolCall !== undefined) input.toolCall = item.toolCall
  if (item.effortOptions !== undefined) {
    input.effortOptions = { levels: [...item.effortOptions.levels] }
  }
  if (item.credits !== undefined) input.credits = item.credits
  return input
}

/**
 * 打开弹窗时的那几行：目录里的模型一行一条，人工补进来的排在后面。
 *
 * 目录与人工那部分都来自服务端：`ListModels { upstreamId }` 给目录，
 * `ListModelOverrides { platformId }` 给人写的那一份。面板不自己推断「这个模型
 * 有没有被改过」—— 人工那份里有它的 id 就是改过。
 */
export function modelRows(
  catalog: CatalogModel[],
  overrides: ModelOverride[]
): ModelRow[] {
  const saved = new Map(
    overrides.map((item) => [item.id, toOverrideInput(item)])
  )
  const rows = catalog.map((model) => rowOf(model.id, model, saved.get(model.id)))
  for (const [id, item] of saved) {
    // 目录里已经有它了：那就是「改了它」，不是「加它」。
    if (catalog.some((model) => model.id === id)) continue
    rows.push(rowOf(id, undefined, item))
  }
  return rows
}

/** 新行的序号：同一份弹窗里每行一个键，删了再加也不会撞。 */
let newRowCount = 0

/** 人工加的一行：id 空着，等用户填。 */
export function newRow(): ModelRow {
  newRowCount += 1
  return {
    key: `人工:新 ${newRowCount}`,
    id: '',
    added: true,
    text: emptyText(),
    reasoning: 'inherit',
    toolCall: 'inherit',
    effortMode: 'inherit',
    touched: [],
  }
}

/**
 * 去掉这一行的人工那部分。
 *
 * 人工加的行整条拿掉：它本来只因为人工条目才在列表里。这里不能按 id 去目录里
 * 找 —— 人工加的行把 id 填成目录里已有的（比如 glm-4.6）时，找回来的是目录那一
 * 行，列表里就多出第二个 glm-4.6，报重复、存不下去，而两条都没有删掉按钮。
 *
 * 目录里有的：回到目录那份值。
 */
export function dropOverride(
  row: ModelRow,
  catalog: CatalogModel[]
): ModelRow[] {
  if (row.added) return []
  const model = catalog.find((item) => item.id === row.id)
  if (!model) return []
  return [rowOf(model.id, model, undefined)]
}

/** 把某一格记成「改过了」。 */
export function touchField(
  touched: OverrideField[],
  field: OverrideField
): OverrideField[] {
  return touched.includes(field) ? touched : [...touched, field]
}

function rowOf(
  id: string,
  model: CatalogModel | undefined,
  saved: OverrideInput | undefined
): ModelRow {
  const savedLevels = saved?.effortOptions?.levels
  const catalogLevels = model?.effortOptions ?? []
  // 人工写下的那一份说得最准：没写 = 不设置，写了空的 = 不能选档。目录里那一
  // 格是 repeated，空表示不知道，所以只有当它真有几档时才算「指定档位」。
  const effortMode: EffortMode =
    savedLevels === undefined
      ? catalogLevels.length > 0
        ? 'levels'
        : 'inherit'
      : savedLevels.length > 0
        ? 'levels'
        : 'none'
  const tiers = savedLevels?.length ? savedLevels : catalogLevels
  return {
    key: model ? `目录:${id}` : `人工:${id}`,
    id,
    added: model === undefined,
    text: {
      displayName: saved?.displayName ?? model?.displayName ?? '',
      contextWindow: numberText(saved?.contextWindow, model?.contextWindow),
      maxOutputTokens: numberText(saved?.maxOutputTokens, model?.maxOutputTokens),
      effortOptions: tiers.join(', '),
      credits: creditsText(saved?.credits, model?.credits),
    },
    reasoning: triState(saved?.reasoning, model?.reasoning),
    toolCall: triState(saved?.toolCall, model?.toolCall),
    effortMode,
    touched: [],
    saved,
  }
}

/**
 * 整数那两格的原文（上下文、输出上限）。
 *
 * 目录里这两格没有「有没有」这一说：0 说的是「不知道」，所以留空（不拿 0 冒充
 * 一个数字）。人写下的 0 照写。
 */
function numberText(saved?: number, fromCatalog?: number): string {
  if (saved !== undefined) return String(saved)
  if (fromCatalog === undefined || fromCatalog === 0) return ''
  return String(fromCatalog)
}

/**
 * 倍率那一格的原文。
 *
 * 目录里这一格分得清「没给」与「给了 0」：没给就是不知道（空着，格子里的字说
 * 「没报」），给了 0 就是免费，要写成 0 —— 空着会被读成不知道。
 */
function creditsText(saved?: number, fromCatalog?: number): string {
  if (saved !== undefined) return String(saved)
  if (fromCatalog === undefined) return ''
  return String(fromCatalog)
}

function triState(
  saved: boolean | undefined,
  fromCatalog: boolean | undefined
): TriState {
  if (saved !== undefined) return saved ? 'yes' : 'no'
  if (fromCatalog === undefined) return 'inherit'
  return fromCatalog ? 'yes' : 'no'
}

/**
 * 保存时发上去的人工那一份。
 *
 * 两条规矩：
 *
 * 1. 只写改过的格。没改的格不发，人工条目里就不会把代码/上游那份值固化成人工值。
 * 2. 目录里、这一轮没碰过、原来也没有人工条目的行整条不发 —— 发一条只写 id 的
 *    条目是「把它加进目录」，跟「没动它」是两件事。
 *
 * 原来就写着的人工格：这一轮没碰的照旧带上（整体替换，不带就等于删掉）。这一轮
 * 改过又清空的格不带：清空表示回到代码/上游那份值。
 */
export function overridesFromRows(rows: ModelRow[]): OverrideInput[] {
  const entries: OverrideInput[] = []
  for (const row of rows) {
    const base = row.saved
    if (!row.added && base === undefined && row.touched.length === 0) continue
    const entry: OverrideInput = { id: row.id.trim() }
    if (base) {
      if (!row.touched.includes('displayName') && base.displayName !== undefined) {
        entry.displayName = base.displayName
      }
      if (
        !row.touched.includes('contextWindow') &&
        base.contextWindow !== undefined
      ) {
        entry.contextWindow = base.contextWindow
      }
      if (
        !row.touched.includes('maxOutputTokens') &&
        base.maxOutputTokens !== undefined
      ) {
        entry.maxOutputTokens = base.maxOutputTokens
      }
      if (!row.touched.includes('reasoning') && base.reasoning !== undefined) {
        entry.reasoning = base.reasoning
      }
      if (!row.touched.includes('toolCall') && base.toolCall !== undefined) {
        entry.toolCall = base.toolCall
      }
      if (
        !row.touched.includes('effortOptions') &&
        base.effortOptions !== undefined
      ) {
        entry.effortOptions = { levels: [...base.effortOptions.levels] }
      }
      if (!row.touched.includes('credits') && base.credits !== undefined) {
        entry.credits = base.credits
      }
    }
    if (row.touched.includes('displayName')) {
      const text = row.text.displayName.trim()
      if (text) entry.displayName = text
    }
    if (row.touched.includes('contextWindow')) {
      const value = numberValue(row.text.contextWindow)
      if (value !== undefined) entry.contextWindow = value
    }
    if (row.touched.includes('maxOutputTokens')) {
      const value = numberValue(row.text.maxOutputTokens)
      if (value !== undefined) entry.maxOutputTokens = value
    }
    if (row.touched.includes('reasoning') && row.reasoning !== 'inherit') {
      entry.reasoning = row.reasoning === 'yes'
    }
    if (row.touched.includes('toolCall') && row.toolCall !== 'inherit') {
      entry.toolCall = row.toolCall === 'yes'
    }
    if (row.touched.includes('effortOptions')) {
      // 三态各自发什么：不设置 = 不带这一格（沿用原来的档位）；不能选档 = 空
      // 列表（契约上跟没写分得开）；指定档位 = 那几档。
      if (row.effortMode === 'none') {
        entry.effortOptions = { levels: [] }
      } else if (row.effortMode === 'levels') {
        const tiers = splitLevels(row.text.effortOptions)
        // 空的下不了（校验会拦），真到这一步也不拿空列表冒充「不能选档」。
        if (tiers.length) entry.effortOptions = { levels: tiers }
      }
    }
    if (row.touched.includes('credits')) {
      const value = numberValue(row.text.credits)
      if (value !== undefined) entry.credits = value
    }
    entries.push(entry)
  }
  return entries
}

/** 逗号分隔的档位原文 → 那几档。多打的逗号、空白都不算一档。 */
export function splitLevels(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
function numberValue(text: string): number | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

/** 契约里 int32 的上界：超了服务端不收，面板先说清。 */
const MAX_INT32 = 2147483647

/** 整数那几格：只收非负整数，超了 int32 也先拦下。 */
function countMessage(text: string, label: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return `${label}：要填整数`
  }
  if (value < 0) return `${label}：不能是负数`
  if (value > MAX_INT32) return `${label}：别超过 ${MAX_INT32}`
  return null
}

/** 倍率：是个数就行，不能是负数；空着表示不知道。 */
function creditsMessage(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return '倍率：要填数字'
  if (value < 0) return '倍率：不能是负数'
  return null
}

/** 界面上那一格该标红（错误挂在哪一格）。 */
export type ProblemField = 'id' | TextField

/**
 * 一条错误。
 *
 * 每条都带着是哪一行（模型 id，人工加的行还没填 id 时说「新模型 N」）与哪一格
 * —— 光说「要填整数」，一列里有十行就不知道是哪一行。
 */
export interface RowProblem {
  /** 摆在界面上那一整句：`glm-4.6 · 上下文：要填整数`。 */
  text: string
  field: ProblemField
  /** 这条错误牵着的行。两行 id 填成同一个是同一条错误，两行都要指过来。 */
  rowIndexes: number[]
}

/**
 * 现在为什么不能保存。空数组表示没问题。
 *
 * 判据都在这里，弹窗只照它画：id 必填、不重复，数字格要填数字，选了「指定
 * 档位」就至少填一档。别的都由服务端说 —— 它说哪一格不合法，那句话原样显示。
 *
 * 同样一句话只摆一次：两行 id 填成同一个，那条「重复」两行各说一遍就是同一句
 * 话摆两遍。
 */
export function listProblems(rows: readonly ModelRow[]): RowProblem[] {
  const duplicates = duplicateIds(rows)
  const out: RowProblem[] = []
  const seen = new Map<string, RowProblem>()

  const add = (index: number, field: ProblemField, message: string) => {
    const label = rowLabel(rows[index], index)
    const text = `${label} · ${message}`
    const known = seen.get(text)
    if (known) {
      if (!known.rowIndexes.includes(index)) known.rowIndexes.push(index)
      return
    }
    const problem: RowProblem = { text, field, rowIndexes: [index] }
    seen.set(text, problem)
    out.push(problem)
  }

  rows.forEach((row, index) => {
    const id = row.id.trim()
    if (id === '') add(index, 'id', '模型 id 不能空')
    else if (duplicates.includes(id)) add(index, 'id', '模型 id 重复')
    const context = countMessage(row.text.contextWindow, '上下文')
    if (context) add(index, 'contextWindow', context)
    const output = countMessage(row.text.maxOutputTokens, '输出上限')
    if (output) add(index, 'maxOutputTokens', output)
    const credits = creditsMessage(row.text.credits)
    if (credits) add(index, 'credits', credits)
    if (
      row.effortMode === 'levels' &&
      splitLevels(row.text.effortOptions).length === 0
    ) {
      add(index, 'effortOptions', '选了指定档位，就至少填一档')
    }
  })
  return out
}

/** 这一行叫什么：有 id 用它，人工加的行还没填 id 就说第几行。 */
function rowLabel(row: ModelRow, index: number): string {
  return row.id.trim() || `新模型 ${index + 1}`
}

/** 重复的模型 id：只有人工加的行才可能撞上目录里的那几条。 */
export function duplicateIds(rows: readonly ModelRow[]): string[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = row.id.trim()
    if (!id) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
}
