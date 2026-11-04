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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { describeError } from '@/lib/errors'
import type { QuotaRegistry } from '@/features/accounts/provider-key-fields'
import { PLATFORM_TEMPLATES, type PlatformTemplate } from './templates'

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
      return `${id}（登记表还没到手）`
    case 'error':
      return `${id}（登记表取不到）`
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
      return '额度插件登记表还没到手：现在只看得见存着的那个 id'
    case 'error':
      return `额度插件登记表取不到：${registry.message}`
    default:
      return unregistered
        ? '这个 id 不在额度插件登记表里：可能填错了，或者那个插件下线了。存下去原样保留'
        : '插件决定这个平台的额度怎么问、怎么读'
  }
}

export type PlatformSubmit = {
  id: string
  label: string
  baseUrl: string
  quotaPlugin: string
  modelsAuto: boolean
  models: string[]
}

type Draft = {
  id: string
  label: string
  baseUrl: string
  quotaPlugin: string
  modelsAuto: boolean
  /** 模型目录：一行一个模型名。 */
  models: string
}

/**
 * 新增或修改一个开放平台。
 *
 * 新增只有三格（id、名字、地址）：服务端建的就是一个空平台，不接 key、不接
 * 模型清单。修改是整单提交 —— 名字、地址、额度插件、模型目录一起发过去，
 * 空串表示清空。
 *
 * 面板不自己定 id 的规则（哪些字符、跟谁重名）：填了什么样由服务端说了算，
 * 它说不行就不行，那句话原样显示。
 */
export function PlatformDialog({
  open,
  platform,
  registry,
  pending,
  error,
  onSubmit,
  onOpenChange,
}: {
  open: boolean
  /** 要改的平台。新增的时候不给。 */
  platform?: Upstream
  /** 额度插件登记表：三档（加载中 / 取不到 / 到手）。 */
  registry: QuotaRegistry
  pending: boolean
  /** 上一次提交的错误：服务端的话，原样显示。 */
  error?: unknown
  onSubmit: (input: PlatformSubmit) => void
  onOpenChange: (open: boolean) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(platform))
  /** 模板搜索框里的字：按名字或 id 过滤模板列表。 */
  const [templateQuery, setTemplateQuery] = useState('')
  /** 选中的那条模板：只是标一下，不参与提交。 */
  const [pickedTemplate, setPickedTemplate] = useState<string>('')

  useEffect(() => {
    // 只看 open：弹窗开着的时候服务端那边变了（刚刷新过目录），不该把用户
    // 已经填的东西抹掉。换个平台改的时候弹窗是关着开的，open 变一次就够。
    if (open) {
      setDraft(toDraft(platform))
      setTemplateQuery('')
      setPickedTemplate('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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

  const editing = platform !== undefined
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
      baseUrl: template.baseUrl,
    })
  }

  const submit = () => {
    onSubmit({
      id: draft.id.trim(),
      label: draft.label.trim(),
      baseUrl: draft.baseUrl.trim(),
      quotaPlugin: draft.quotaPlugin,
      modelsAuto: draft.modelsAuto,
      // 自动拉的时候不动现在那份目录（服务端的约定）：不带清单。
      models: draft.modelsAuto ? [] : parseModels(draft.models),
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
            {editing
              ? '这一单是整单提交的：改一处也要把现在的值一起带上。地址改了以后客户端要换地址'
              : '先建一个空平台：不接 key、不接模型清单，那些是后面的事。id 是客户端地址里的一段。上面选一条模板能少填几格'}
          </DialogDescription>
        </DialogHeader>

        <div className='grid gap-4'>
          {editing ? null : (
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
              <p className='text-xs text-muted-foreground'>
                模板是捷径不是必经：选一条会填上 id、名字、地址，填完还能改；
                不选模板直接手填也行
              </p>
            </div>
          )}

          <div className='grid gap-2'>
            <Label htmlFor='platform-id'>平台 id</Label>
            <Input
              id='platform-id'
              value={draft.id}
              disabled={editing}
              placeholder='比如 my-gateway'
              onChange={(event) => patch({ id: event.target.value })}
            />
            <p className='text-xs text-muted-foreground'>
              {editing
                ? 'id 是这个平台在客户端地址里的一段，改不了'
                : '客户端走的是 /{id}/v1。id 的规则由服务端定，填错它会说明'}
            </p>
          </div>

          <div className='grid gap-2'>
            <Label htmlFor='platform-label'>名字</Label>
            <Input
              id='platform-label'
              value={draft.label}
              placeholder='比如 我的中转站'
              onChange={(event) => patch({ label: event.target.value })}
            />
          </div>

          <div className='grid gap-2'>
            <Label htmlFor='platform-base-url'>地址</Label>
            <Input
              id='platform-base-url'
              value={draft.baseUrl}
              placeholder='https://api.example.com/v1'
              onChange={(event) => patch({ baseUrl: event.target.value })}
            />
          </div>

          {editing ? (
            <>
              <div className='grid gap-2'>
                <Label htmlFor='platform-quota-plugin'>额度插件</Label>
                <Select
                  value={draft.quotaPlugin === '' ? NO_PLUGIN : draft.quotaPlugin}
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

              {selected ? (
                <div className='grid gap-1 rounded-md border p-3'>
                  <p className='text-sm font-medium'>
                    这个插件要这几段凭据
                  </p>
                  {selected.fields.length ? (
                    <ul className='list-disc ps-5 text-xs text-muted-foreground'>
                      {selected.fields.map((field) => (
                        <li key={field.name}>
                          {field.label}
                          {field.secret ? '（面板上遮起来显示）' : ''}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className='text-xs text-muted-foreground'>
                      这个插件不用额外的凭据
                    </p>
                  )}
                  <p className='text-xs text-muted-foreground'>
                    这几段凭据在账号那一行的「凭据」里填：推理用的 API key 在前，这几段按上面的顺序在后
                  </p>
                </div>
              ) : null}

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
                    ? '自动拉的时候这份目录由上游给，这里改不了'
                    : '一行一个模型名。留空表示保留现在这份目录'}
                </p>
              </div>
            </>
          ) : null}

          {error ? (
            <p role='alert' className='text-sm text-destructive'>
              {describeError(error)}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={pending} onClick={submit}>
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
      baseUrl: '',
      quotaPlugin: '',
      modelsAuto: false,
      models: '',
    }
  }
  return {
    id: platform.id,
    label: platform.label,
    baseUrl: platform.baseUrl,
    quotaPlugin: platform.quotaPlugin,
    modelsAuto: platform.modelsAuto,
    models: platform.models.join('\n'),
  }
}
