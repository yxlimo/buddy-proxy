import { useEffect, useMemo, useState } from 'react'
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { describeError } from '@/lib/errors'
import type { QuotaRegistry } from '@/features/accounts/provider-key-fields'
import type { PlatformKind } from '@/gen/buddy/admin/v1/admin_pb'
import {
  isSimulatedKind,
  platformKindHint,
  platformKindPlaceholder,
  platformKindReadout,
  platformKindValue,
  simulatedPresetOf,
  type PlatformKindList,
} from './platform-kinds'
import { PLATFORM_TEMPLATES, type PlatformTemplate } from './templates'
import { platformProblems, MISSING_TEXT, type PlatformField } from './platform-form'

/**
 * 「不用插件」在契约里是空串，但下拉框的选项不能是空串（那是控件的限制），
 * 所以这里用一个别的值代表它，提交时再换回空串。
 *
 * 这个串不能跟真的插件 id 撞：登记表里的 id 只由小写字母、数字与连字符组成
 * （`[a-z0-9-]`），所以带星号的这一串永远不会是插件 id。
 */
const NO_PLUGIN = '*none*'

/**
 * 下拉里那一项「已选、但登记表里没有」的 id 怎么显示。
 *
 * 「未知插件」只有在登记表到手之后才说得准：还在加载、或者取不到的时候，
 * 登记过的插件也会被说成「未知」—— 那句话是错的，所以那样的时候只说
 * 「登记表还没到手 / 取不到」，把 id 原样摆着。
 *
 * 不管哪一种，提交上去的都是原来那个 id：面板不替用户把它改成第一项。
 */
function storedPluginLabel(id: string, registry: QuotaRegistry): string {
  switch (registry.status) {
    case 'pending':
      return `${id}（列表还在加载）`
    case 'error':
      return `${id}（列表取不到）`
    default:
      return `未知插件 ${id}`
  }
}

/**
 * 下拉框下面那一行提示。
 *
 * 先按登记表的状态说：没到手的时候「不在登记表里」这个判断本身就不成立 ——
 * 登记过的插件也会被说成填错了。只有到手了、且里面真的没这个 id，才说可能
 * 填错或插件下线。
 */
function pluginHint(registry: QuotaRegistry, unregistered: string): string {
  switch (registry.status) {
    case 'pending':
      return '插件列表还在加载，暂时只能看到原来那个 id'
    case 'error':
      return `插件列表取不到：${registry.message}`
    default:
      return unregistered
        ? '这个 id 不在已知插件里，仍会原样保存。'
        : '决定这个平台怎么查额度'
  }
}

export type PlatformSubmit = AddPlatformSubmit | UpdatePlatformSubmit

/**
 * 新增那一单。
 *
 * 类型是建平台时选的一格：建完就改不了，所以只有这一单带它。
 */
export type AddPlatformSubmit = {
  id: string
  label: string
  baseUrl: string
  /** 用哪一类适配器（清单里的一个 kind）。 */
  kind: string
}

/**
 * 修改那一单。
 *
 * 契约里 UpdatePlatform 没有 kind 这一格：类型建完就改不了，所以这里不带它 ——
 * 不是「带上但 hook 会挑掉」，是这一单本身就没有。
 *
 * 地址与额度插件对模拟客户端是不适用的两格（归代码）：那一族提交时这两格
 * **不出现**，不是出现但为空串。合同里 `quota_plugin` 的约定是「空串 = 清空
 * 这一格」，所以发空串就是抹掉库里那份用户以后可能填的值。
 */
export type UpdatePlatformSubmit = {
  id: string
  label: string
  /** 模拟客户端不带这一格（地址归代码）。 */
  baseUrl?: string
  /** 模拟客户端不带这一格（额度插件归代码）。 */
  quotaPlugin?: string
  /**
   * 用共性表补模型参数。
   *
   * 没动过这一格就不带：后端「没给 = 别动这一格」，带一个默认值是错的（那是
   * 明确写了一遍）。关掉这一格要带 `false`，它与「没给」不是一回事。
   */
  traitsFromCommon?: boolean
  modelsAuto: boolean
  models: string[]
}

type Draft = {
  id: string
  label: string
  /**
   * 名字是不是用户自己敲的。
   *
   * 面板填的名字（预置的名字、模板的名字）不是用户的值：换一条类型时该跟着换。
   * 靠「现在这个名字是不是上一条的名字」猜是不行的 —— 两条类型同名的时
   * 候猜不出来，而且上一条名字本身也是面板填的。只有名字那一格的 onChange
   * 置这个标志。
   */
  labelEdited: boolean
  baseUrl: string
  /**
   * 选中的那一条（见 `platformKindValue`：方言看 kind，模拟客户端看 presetId）。
   * 改平台时没有这一格 —— 类型建完就改不了。
   */
  choice: string
  quotaPlugin: string
  modelsAuto: boolean
  /** 模型目录：一行一个模型名。 */
  models: string
  /** 用共性表补模型参数这一格现在开着没有（这一格缺失时按关显示）。 */
  traitsFromCommon: boolean
  /**
   * 用户动过这一格吗。
   *
   * 没动过就不往请求里放（后端「没给 = 别动」）：面板不替用户把现在的值再写
   * 一遍。
   */
  traitsFromCommonEdited: boolean
}

/**
 * 下拉里的两组：模拟客户端在前（能建的多半是这一类，条目也多），方言在后。
 *
 * 分组的判据只有 `category`；看不出类别的（老服务端不带这一格）算方言 —— 那种
 * 时候它也只有方言可给。
 */
function kindGroups(
  options: PlatformKind[]
): { title: string; items: PlatformKind[] }[] {
  const simulated = options.filter(isSimulatedKind)
  const dialect = options.filter((item) => !isSimulatedKind(item))
  const groups: { title: string; items: PlatformKind[] }[] = []
  if (simulated.length) groups.push({ title: '模拟客户端', items: simulated })
  if (dialect.length) groups.push({ title: '开放平台', items: dialect })
  return groups
}

/**
 * 新增或修改一个开放平台。
 *
 * 新增只有三格（id、名字、地址）：服务端建的就是一个空平台，不接 key、不接
 * 模型清单。修改是整单提交 —— 名字、地址、额度插件、模型目录一起发过去，
 * 空串表示清空。
 *
 * 选到模拟客户端时只有名字一格是能填的：id、地址、区域都是那个客户端的身份
 * （改了会话就接不上），面板不摆那几格，提交时按预置填。
 *
 * id 能不能用、地址是不是网址，面板先用自己手头的数据判（平台列表、账号
 * id）：判出来的问题摆在那一格下面，保存按钮灰着，请求不发。服务端那套校验
 * 照样在，它管的是别的客户端与并发 —— 那时它说不行就是不行，那句话原样显示。
 */
export function PlatformDialog({
  open,
  platform,
  existing,
  kinds,
  registry,
  pending,
  error,
  onSubmit,
  onOpenChange,
}: {
  open: boolean
  /** 要改的平台。新增的时候不给。 */
  platform?: Upstream
  /** 表里现有的平台（含播种的模拟客户端）：id 重不重、是不是账号名，看它。 */
  existing: readonly Upstream[]
  /** 建平台时能选的类型清单：三档（加载中 / 取不到 / 到手）。 */
  kinds: PlatformKindList
  /** 额度插件登记表：三档（加载中 / 取不到 / 到手）。 */
  registry: QuotaRegistry
  pending: boolean
  /** 上一次提交的错误：服务端的话，原样显示。 */
  error?: unknown
  /**
   * 交上去。新增那一单带 kind，改那一单不带（`PlatformSubmit` 是两个类型）。
   */
  onSubmit: (input: PlatformSubmit) => void
  onOpenChange: (open: boolean) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(platform))
  /**
   * 用户碰过哪几格。
   *
   * 「没填」那句话只在碰过之后才摆：新开一个空表单，一行红字先骂起来没有意义。
   * 填错了（格式、被占用）都是敲进去才有的，不用等这个标志。
   */
  const [touched, setTouched] = useState<Partial<Record<PlatformField, true>>>(
    {}
  )
  /** 模板搜索框里的字：按名字或 id 过滤模板列表。 */
  const [templateQuery, setTemplateQuery] = useState('')
  /** 选中的那条模板：只是标一下，不参与提交。 */
  const [pickedTemplate, setPickedTemplate] = useState<string>('')

  useEffect(() => {
    // 打开的时候按这一单重铺草稿。
    //
    // 依赖里也盯平台 id：弹窗开着的时候父组件换了平台（列表刷新、或者从别处
    // 点进来），只盯 open 的话表单留着上一个平台的旧值、标题是新名字，提交
    // 就写错了行。服务端那边只是同一个平台的值变了，不重铺 —— 那会把用户已经
    // 填的东西抹掉。
    if (open) {
      setDraft(toDraft(platform))
      setTouched({})
      setTemplateQuery('')
      setPickedTemplate('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, platform?.id])

  /** 模板列表：按名字或 id 过滤（大小写不管）。 */
  const shownTemplates = useMemo(() => {
    const query = templateQuery.trim().toLowerCase()
    if (!query) return PLATFORM_TEMPLATES
    return PLATFORM_TEMPLATES.filter(
      (item) =>
        item.label.toLowerCase().includes(query) ||
        item.id.toLowerCase().includes(query)
    )
  }, [templateQuery])

  const patch = (part: Partial<Draft>) =>
    setDraft((prev) => ({ ...prev, ...part }))

  /** 碰过这一格（敲进来的字以后清空也算碰过）。 */
  const touch = (field: PlatformField) =>
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }))

  const editing = platform !== undefined
  // 清单到手了才有可选项；没到手、取不到的时候一个也没有。
  const kindOptions = kinds.status === 'ready' ? kinds.kinds : []
  const chosenKind = kindOptions.find(
    (item) => platformKindValue(item) === draft.choice
  )
  // 选中的那一条是模拟客户端时的预置；是方言就是 undefined。
  const chosenPreset =
    chosenKind && isSimulatedKind(chosenKind) ? chosenKind : undefined
  // 改的是不是一个模拟客户端：按 id 与 kind 认出是哪一条预置（两个 Qoder 的
  // kind 相同，拿 kind 认不出来）。认不出来就照方言那套摆。
  const preset = platform ? simulatedPresetOf(kinds, platform) : chosenPreset
  // 改的时候清单可能还没到手（加载中 / 取不到），那时认不出是哪一条预置；但
  // 是不是模拟客户端平台那一条自己说得出来：服务端没把它明确算作开放平台的，
  // 就是那一族。地址与额度插件两格归代码，不摆也不往上送。
  //
  // 判据只看族（服务端那一格说的是这个），不看「表里有没有这一行」：有没有行、
  // 能不能改删是另一件事，掺进来就会多出一条「模拟客户端被当成开放平台 → 发
  // 空串 → 抹掉库里那份插件 id」的路。
  //
  // 判据写成「不为 true」而不是「等于 false」：这一格缺失（老服务端 / 形状里
  // 没有它）时不能当成「不是模拟客户端」—— 那样会给模拟客户端露出地址格，
  // 用户一填就写进那一行。真开放平台这一格一定是 true。
  const simulated =
    preset !== undefined ||
    (platform !== undefined && platform.isOpenPlatform !== true)
  // 模拟客户端的 id 由预置定死：请求路径里那一段，也是调用方 base_url 的那一段。
  const fixedId = simulated ? (preset?.presetId || platform?.id || '') : ''
  // 清单现在怎么了：三档各一句（加载中 / 取不到 / 一条也没有）。有得选的时候
  // 这一行不摆；占位符与这行从同一处取，两处说法一致。
  const kindOptionHint = platformKindHint(kinds)
  // 「类型：xxx」那一行（改的时候）：判据在 platform-kinds.ts，卡片用的是同一个。
  const readonlyKind = platform ? platformKindReadout(kinds, platform) : null

  // id 重不重、是不是账号名：看表里现有的平台与它们名下的账号（两边共用一个
  // 命名空间）。改平台时把自己那一行排掉 —— 它当然跟自己的 id 重。
  const takenIds = useMemo(
    () =>
      existing.filter((item) => item.id !== platform?.id).map((item) => item.id),
    [existing, platform?.id]
  )
  const accountIds = useMemo(
    () =>
      existing.flatMap((item) =>
        item.accounts.map((account) => account.id)
      ),
    [existing]
  )
  // 提交前就能说清的那几件错：id 空/格式/自用/被占，名字空，地址空/不是网址。
  const problems = platformProblems({
    // 改平台时 id 改不了；模拟客户端的 id 由预置定，两处都不判这一格。
    id: editing || simulated ? undefined : draft.id,
    label: draft.label,
    // 模拟客户端的地址归代码，不摆也不判。
    baseUrl: simulated ? undefined : draft.baseUrl,
    takenIds,
    accountIds,
  })
  /**
   * 这一格下面摆不摆那句话。
   *
   * 「没填」只在碰过之后摆（新开的空表单不先骂人）；填错了（格式、被占用）
   * 都是敲进去才有的，一律摆。
   */
  const shown = (field: PlatformField): string | undefined => {
    const text = problems[field]
    if (!text) return undefined
    return draft[field].trim() === '' && !touched[field] ? undefined : text
  }
  // 有一格不对就不发请求：那些错在保存前就看得见。
  const blocked = Object.keys(problems).length > 0
  /** 还差哪几格（页脚那一行用）：只说缺哪几格，不把三句「没填」在页脚再摆一遍。 */
  const missing = (['id', 'label', 'baseUrl'] as PlatformField[]).filter(
    (field) => problems[field] === MISSING_TEXT[field]
  )
  const MISSING_LABEL: Record<PlatformField, string> = {
    id: '平台 id',
    label: '名字',
    baseUrl: '地址',
  }

  useEffect(() => {
    // 新增：清单到手后默认选第一条（顺序照服务端给的）。改的时候没有这一格。
    //
    // 依赖里带上 open：弹窗每开一次都把草稿重置成空的，重置完得重新选一次。
    // 只看 kinds 的话，清单早就到手了，打开弹窗时这条 effect 不会再跑，类型
    // 就会一直空着（保存一直禁用）。
    if (!open || editing || kinds.status !== 'ready') return
    const first = kinds.kinds[0]
    if (!first) return
    setDraft((prev) =>
      kinds.kinds.some((item) => platformKindValue(item) === prev.choice)
        ? prev
        : {
            ...prev,
            choice: platformKindValue(first),
            // 地址是空的才用这一类的默认地址占位；填过的不动。
            baseUrl: isSimulatedKind(first)
              ? ''
              : prev.baseUrl.trim()
                ? prev.baseUrl
                : first.defaultBaseUrl,
            // 名字空着、选中的又是预置：填它的名字（能改）。
            label:
              isSimulatedKind(first) && !prev.labelEdited && !prev.label.trim()
                ? first.label
                : prev.label,
          }
    )
  }, [open, editing, kinds])

  /**
   * 换一条类型。
   *
   * 地址是空的时候用这一类的默认地址占位（模拟客户端的地址由模拟端定，留空）。
   * 名字没被用户改过时跟着换成这一条的名字：换一条预置却留着上一条的名字，
   * 建出来就是一个名字对不上的平台。
   *
   * 离开预置那一族（模拟客户端 → 方言）时 id 与额度插件都清掉：那两格在预置
   * 那边是不摆的，草稿里留着的东西跟现在选中的类型没关系 —— 提交上去就成了
   * 一个用户没填过的 id、一个不相干的插件。
   */
  const chooseKind = (value: string) => {
    const option = kindOptions.find((item) => platformKindValue(item) === value)
    setDraft((prev) => {
      const previous = kindOptions.find(
        (item) => platformKindValue(item) === prev.choice
      )
      const simulated = option ? isSimulatedKind(option) : false
      const leavingPreset =
        !simulated && (previous ? isSimulatedKind(previous) : false)
      return {
        ...prev,
        choice: value,
        id: leavingPreset ? '' : prev.id,
        baseUrl: simulated
          ? ''
          : prev.baseUrl.trim()
            ? prev.baseUrl
            : (option?.defaultBaseUrl ?? ''),
        // 模拟客户端的额度不走平台这一行：草稿里那个插件 id 跟它无关。
        quotaPlugin: simulated ? '' : prev.quotaPlugin,
        label: prev.labelEdited
          ? prev.label
          : simulated
            ? (option?.label ?? '')
            : '',
      }
    })
  }
  // 登记表到手了才有可选项；没到手、取不到的时候只有存着的那个 id。
  const plugins = registry.status === 'ready' ? registry.plugins : []
  // 选中的插件：登记表里有的那个。存着的 id 不在登记表里（或者登记表还没
  // 到手）时，那一格也要看得见 —— 不然下拉框里是空的，看着像没选。
  const selected = plugins.find((item) => item.id === draft.quotaPlugin)
  const unregistered =
    draft.quotaPlugin !== '' && !selected ? draft.quotaPlugin : ''

  /**
   * 选一条模板：把 id、名字、地址三格填上。
   *
   * 填完这三格还是能改的 —— 模板是起点，不是定好的答案。模板表里不做「只能用
   * 一次」那类判断：id 撞了就是那个平台已经存在，服务端会说明。
   */
  const pickTemplate = (template: PlatformTemplate) => {
    setPickedTemplate(template.id)
    patch({
      id: template.id,
      label: template.label,
      // 模板给的名字是面板填的，不是用户敲的：换一条类型时该跟着换。
      labelEdited: false,
      baseUrl: template.baseUrl,
    })
  }

  const submit = () => {
    if (editing) {
      const shared = {
        id: draft.id.trim(),
        label: draft.label.trim(),
        modelsAuto: draft.modelsAuto,
        // 自动拉的时候不动现在那份目录（服务端的约定）：不带清单。
        models: draft.modelsAuto ? [] : parseModels(draft.models),
      }
      // 模拟客户端的地址与额度插件归代码：这两格整格不出现。发空串是「清空
      // 那一格」的意思，会把库里原来那份抹掉。
      if (simulated) {
        onSubmit(shared)
        return
      }
      const update: UpdatePlatformSubmit = {
        ...shared,
        baseUrl: draft.baseUrl.trim(),
        quotaPlugin: draft.quotaPlugin,
      }
      // 只有用户动过这一格才带：契约里它是 optional bool，没给就是「别动这一格」。
      // 带一个默认值等于替用户写一遍，把它自己改过的值盖回去。
      if (draft.traitsFromCommonEdited) {
        update.traitsFromCommon = draft.traitsFromCommon
      }
      onSubmit(update)
      return
    }
    onSubmit({
      // 模拟客户端：id 是预置定的那一个，不是下拉里那个值本身（方言的
      // 下拉值是 kind，不是 id）。
      id: simulated ? fixedId : draft.id.trim(),
      label: draft.label.trim(),
      baseUrl: simulated ? '' : draft.baseUrl.trim(),
      kind: chosenKind?.kind ?? '',
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>
            {editing ? `改平台 ${platform.label || platform.id}` : '新增平台'}
          </DialogTitle>
          <DialogDescription>
            {simulated
              ? '模拟客户端的 id 与地址是固定的，改不了'
              : editing
                ? '地址改了以后客户端要换地址。'
                : '先建一个空平台。id 是客户端地址里的一段。'}
          </DialogDescription>
        </DialogHeader>

        <div className='grid gap-4'>
          {editing ? (
            // 类型改不了（契约里 UpdatePlatform 没有这一格），只摆一行只读的。
            // kind 空着、清单没到手都说不准名字：那些时候整行不摆。
            readonlyKind ? (
              <p className='text-sm'>{`类型：${readonlyKind}`}</p>
            ) : null
          ) : (
            <div className='grid gap-2'>
              <Label htmlFor='platform-kind'>类型</Label>
              <Select
                value={chosenKind ? platformKindValue(chosenKind) : ''}
                disabled={kindOptions.length === 0}
                onValueChange={chooseKind}
              >
                <SelectTrigger id='platform-kind' aria-label='类型'>
                  <SelectValue placeholder={platformKindPlaceholder(kinds)} />
                </SelectTrigger>
                <SelectContent>
                  {kindGroups(kindOptions).map((group) => (
                    <SelectGroup key={group.title}>
                      <SelectLabel>{group.title}</SelectLabel>
                      {group.items.map((item) => (
                        <SelectItem
                          key={platformKindValue(item)}
                          value={platformKindValue(item)}
                        >
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {/* 清单取不到的时候补上原因。其余两档（还在加载 / 一条也没有）
                  上面那一行占位已经把话说完了，不重复一遍。 */}
              {kindOptionHint ? (
                <p className='text-xs text-muted-foreground'>
                  {kindOptionHint}
                </p>
              ) : null}
            </div>
          )}

          {/* 模板表里是第三方厂商的地址与名字：先填三格再改。模拟客户端的
              id 与地址由预置定，用不上这一块。 */}
          {editing || simulated ? null : (
            <div className='grid gap-2'>
              <Label htmlFor='platform-template-search'>搜模板</Label>
              <Input
                id='platform-template-search'
                value={templateQuery}
                placeholder='按名字或 id 搜'
                onChange={(event) => setTemplateQuery(event.target.value)}
              />
              <div
                role='group'
                aria-label='模板列表'
                className='max-h-56 overflow-y-auto rounded-md border'
              >
                {shownTemplates.length ? (
                  shownTemplates.map((template) => (
                    <button
                      key={template.id}
                      type='button'
                      aria-current={
                        pickedTemplate === template.id ? 'true' : undefined
                      }
                      onClick={() => pickTemplate(template)}
                      className='flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent aria-[current=true]:bg-accent'
                    >
                      <span className='text-sm font-medium'>
                        {template.label}
                      </span>
                      <span className='text-xs text-muted-foreground'>
                        {template.baseUrl}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className='px-3 py-2 text-sm text-muted-foreground'>
                    没有匹配的模板
                  </p>
                )}
              </div>
            </div>
          )}

          {simulated ? (
            // 模拟客户端的 id 是它自己的身份（客户端路径里那一段）：只摆出来，
            // 不给改 —— 改了就认不出是哪一个客户端了。
            <div className='grid gap-2'>
              <p className='text-sm font-medium'>平台 id</p>
              <p className='font-mono text-sm'>{fixedId}</p>
              <p className='text-xs text-muted-foreground'>
                {`客户端走的是 /${fixedId}/v1`}
              </p>
            </div>
          ) : (
            <div className='grid gap-2'>
              <Label htmlFor='platform-id'>平台 id</Label>
              <Input
                id='platform-id'
                value={draft.id}
                disabled={editing}
                placeholder='比如 my-gateway'
                aria-invalid={shown('id') ? true : undefined}
                aria-describedby={shown('id') ? 'platform-id-problem' : undefined}
                onChange={(event) => {
                  touch('id')
                  patch({ id: event.target.value })
                }}
              />
              {shown('id') ? (
                <p
                  id='platform-id-problem'
                  className='text-xs text-destructive'
                >
                  {shown('id')}
                </p>
              ) : null}
              <p className='text-xs text-muted-foreground'>
                {editing
                  ? 'id 是这个平台在客户端地址里的一段，改不了'
                  : '客户端走的是 /{id}/v1。'}
              </p>
            </div>
          )}

          <div className='grid gap-2'>
            <Label htmlFor='platform-label'>名字</Label>
            <Input
              id='platform-label'
              value={draft.label}
              placeholder='比如 我的中转站'
              aria-invalid={shown('label') ? true : undefined}
              aria-describedby={
                shown('label') ? 'platform-label-problem' : undefined
              }
              onChange={(event) => {
                // 用户敲过的名字不再跟着类型走。
                touch('label')
                patch({ label: event.target.value, labelEdited: true })
              }}
            />
            {shown('label') ? (
              <p
                id='platform-label-problem'
                className='text-xs text-destructive'
              >
                {shown('label')}
              </p>
            ) : null}
          </div>

          {/* 地址：模拟客户端的发到哪由模拟端定（库里那个是空串），不摆这一格。 */}
          {simulated ? null : (
            <div className='grid gap-2'>
              <Label htmlFor='platform-base-url'>地址</Label>
              <Input
                id='platform-base-url'
                value={draft.baseUrl}
                placeholder='https://api.example.com/v1'
                aria-invalid={shown('baseUrl') ? true : undefined}
                aria-describedby={
                  shown('baseUrl') ? 'platform-base-url-problem' : undefined
                }
                onChange={(event) => {
                  touch('baseUrl')
                  patch({ baseUrl: event.target.value })
                }}
              />
              {shown('baseUrl') ? (
                <p
                  id='platform-base-url-problem'
                  className='text-xs text-destructive'
                >
                  {shown('baseUrl')}
                </p>
              ) : null}
            </div>
          )}

          {editing ? (
            <>
              {/* 模拟客户端的额度不走平台这一行（库里的插件 id 是空串）：摆一
                  个选不了东西的下拉只会让人以为要填。 */}
              {simulated ? null : (
                <div className='grid gap-2'>
                  <Label htmlFor='platform-quota-plugin'>额度插件</Label>
                  <Select
                    value={
                      draft.quotaPlugin === '' ? NO_PLUGIN : draft.quotaPlugin
                    }
                    onValueChange={(value) =>
                      patch({ quotaPlugin: value === NO_PLUGIN ? '' : value })
                    }
                  >
                    <SelectTrigger id='platform-quota-plugin'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_PLUGIN}>不用插件</SelectItem>
                      {plugins.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                      {/* 存着的 id 不在可选项里：摆出来，别让它变成一个空下拉框，
                        也别把它静默改写回第一项。 */}
                      {unregistered ? (
                        <SelectItem value={unregistered}>
                          {storedPluginLabel(unregistered, registry)}
                        </SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                  <p className='text-xs text-muted-foreground'>
                    {pluginHint(registry, unregistered)}
                  </p>
                </div>
              )}

              {selected && !simulated ? (
                <div className='grid gap-1 rounded-md border p-3'>
                  <p className='text-sm font-medium'>
                    这个插件要这几段凭据
                  </p>
                  {selected.fields.length ? (
                    <ul className='list-disc ps-5 text-xs text-muted-foreground'>
                      {selected.fields.map((field) => (
                        <li key={field.name}>{field.label}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className='text-xs text-muted-foreground'>
                      这个插件不用额外的凭据
                    </p>
                  )}
                  <p className='text-xs text-muted-foreground'>
                    这几段凭据在账号那一行的「凭据」里填
                  </p>
                </div>
              ) : null}

              {/* 模拟客户端的目录归代码（后端对这一族的 models / modelsAuto 一律
                  忽略）：不摆开关与文本域，只留一句说清。 */}
              {simulated ? (
                <p className='text-sm text-muted-foreground'>
                  模型目录由代码提供，不能改。
                </p>
              ) : (
                <div className='grid gap-2'>
                  <label
                    htmlFor='platform-models-auto'
                    className='flex items-center gap-2 text-sm'
                  >
                    <Switch
                      id='platform-models-auto'
                      aria-label='自动拉模型目录'
                      checked={draft.modelsAuto}
                      onCheckedChange={(checked) =>
                        patch({ modelsAuto: checked })
                      }
                    />
                    自动拉模型目录
                  </label>
                  <Label htmlFor='platform-models'>模型目录</Label>
                  <Textarea
                    id='platform-models'
                    value={draft.models}
                    disabled={draft.modelsAuto}
                    rows={4}
                    placeholder='一行一个模型名'
                    onChange={(event) => patch({ models: event.target.value })}
                  />
                  <p className='text-xs text-muted-foreground'>
                    {draft.modelsAuto
                      ? '自动拉的时候这份目录由平台给，这里改不了'
                      : '留空表示保留现在这份目录'}
                  </p>
                </div>
              )}

              {/* 共性表：只有目录归上游的开放平台才有「平台没报的参数」这回事。
                  模拟客户端的参数归代码，不摆这一格。 */}
              {simulated ? null : (
                <div className='grid gap-2'>
                  <div className='flex items-center gap-2'>
                    <Switch
                      id='platform-traits-from-common'
                      checked={draft.traitsFromCommon}
                      onCheckedChange={(checked) =>
                        patch({
                          traitsFromCommon: checked,
                          // 动过一次就算动过：再拨回来也是「明确关掉」，带 false。
                          traitsFromCommonEdited: true,
                        })
                      }
                    />
                    <Label htmlFor='platform-traits-from-common'>
                      用共性表补模型参数
                    </Label>
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    平台没报的能力参数按模型 id 从共性表取
                  </p>
                </div>
              )}
            </>
          ) : null}

          {error ? (
            <p role='alert' className='text-sm text-destructive'>
              {describeError(error)}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          {/* 按钮灰着的时候旁边说清差什么：新开的空表单一行红字都没敲就先骂起来
              没有意义，这两句合到这一行里说。 */}
          {missing.length ? (
            <p className='me-auto text-xs text-muted-foreground'>
              {`还差：${missing.map((field) => MISSING_LABEL[field]).join('、')}`}
            </p>
          ) : null}
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={pending || (!editing && !chosenKind) || blocked}
            onClick={submit}
          >
            {editing ? '保存' : '加上'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 表格里的模型目录：一行一个。空行不算。 */
function parseModels(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * 弹窗里现在这几格。
 *
 * 改的时候从平台上取现在的值（整单提交要的就是它们）；模型目录也在这儿 ——
 * 平台上的那一份目录，一行一个模型名。
 */
function toDraft(platform?: Upstream): Draft {
  if (!platform) {
    return {
      id: '',
      label: '',
      labelEdited: false,
      baseUrl: '',
      // 空串：清单到手后由上面那个 effect 选第一条。
      choice: '',
      quotaPlugin: '',
      modelsAuto: false,
      models: '',
      // 新增没有平台行，这一格没有意义（界面上也不摆）。
      traitsFromCommon: false,
      traitsFromCommonEdited: false,
    }
  }
  return {
    id: platform.id,
    label: platform.label,
    // 平台上的名字是用户的值（改平台没有类型这一格，也没人换它）。
    labelEdited: true,
    baseUrl: platform.baseUrl,
    // 改平台没有类型这一格（契约里 UpdatePlatform 没有它）。
    choice: '',
    quotaPlugin: platform.quotaPlugin,
    modelsAuto: platform.modelsAuto,
    models: platform.models.join('\n'),
    // 还没动过：提交时不带这一格。
    traitsFromCommon: traitsFromCommonOf(platform),
    traitsFromCommonEdited: false,
  }
}

/**
 * 平台上这一格现在开着没有。
 *
 * 老服务端（或老库）的平台上没有这一格：那时按关显示 —— 这一格说是 true 才是
 * 开着，其余（false、缺失）都算关。
 */
function traitsFromCommonOf(platform: Upstream): boolean {
  return platform.traitsFromCommon === true
}
