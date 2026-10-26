import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { KeyRound, RotateCcw, Save } from 'lucide-react'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConfig, useSetConfig } from '@/features/config/api'
import type { ConfigItem } from '@/gen/buddy/admin/v1/admin_pb'

const SOURCE_LABELS: Record<string, string> = {
  database: '数据库覆盖',
  environment: '环境变量',
  default: '默认值',
}

/**
 * 分组的中文名。
 *
 * 服务端给的 group 是英文的键（general、gateway……），那是给机器看的。
 * 这个表只是「键 → 中文名」的对照，不是对服务端有哪些组的假设：认不出来
 * 的组就原样显示，不猜。
 *
 * 表里只有网关自己那两个组：上游的开关在「上游」页，不在配置页里，
 * 所以上游那些组不会再出现。
 */
const GROUP_LABELS: Record<string, string> = {
  general: '常规',
  gateway: '网关',
}

/**
 * tab 的顺序。
 *
 * 只是排个先后：服务端没给的组不画，冒出来的新组接在后面。
 */
const GROUP_ORDER = ['general', 'gateway']

function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group
}

/**
 * 服务端对敏感项回的是掩码，不是真值。
 *
 * 掩码长得太像值了：一旦把它当输入回传，库里就会写进一个叫 "***" 的
 * 密钥，重启后 parseBool 认不出来，门就开了。所以掩码只是「有没有值」的
 * 提示，绝不当值用。
 */
const SECRET_MASK = '***'

/**
 * 这一项现在有没有值。
 *
 * has_value 是契约里的字段，服务端还没填的时候看别的：来源是数据库覆盖
 * 或环境变量就说明有人给过值了；值不是掩码也是。
 */
function hasValue(item: ConfigItem): boolean {
  if (item.hasValue) return true
  if (item.source === 'database' || item.source === 'environment') {
    return true
  }
  return Boolean(item.value) && item.value !== SECRET_MASK
}

/**
 * 这一项叫什么。
 *
 * 契约里给了 label（自然语言的名字）。没有 label 就用 description 的第一句，
 * 实在没有才退回键名 —— 键名是给机器看的，不当主要显示。
 */
function itemTitle(item: ConfigItem): string {
  if (item.label.trim()) return item.label.trim()
  const firstSentence = item.description.split(/[。\n]/)[0]?.trim()
  if (firstSentence) return firstSentence
  return item.key
}

/**
 * 标题下面那一行说明。
 *
 * 标题是 label 的时候，描述整段显示；标题是从描述里取的第一句时，描述的
 * 剩下那半句显示在这儿，不重复一遍。
 */
function itemDescription(item: ConfigItem): string {
  const description = item.description.trim()
  if (!description) return ''
  if (item.label.trim()) return description
  const first = description.split(/[。\n]/)[0]?.trim() ?? ''
  return description.slice(first.length).replace(/^[。\s]+/, '').trim()
}

/** 标题用的是键名的时候，就不用再在下面重复一遍了。 */
function showKey(item: ConfigItem): boolean {
  return itemTitle(item) !== item.key
}

export function ConfigPage() {
  const config = useConfig()
  const setConfig = useSetConfig()
  const [editing, setEditing] = useState<{
    key: string
    title: string
    description: string
    secret: boolean
  } | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // 打开配置页停在「常规」那一组。
  const [tab, setTab] = useState('general')

  const groups = useMemo(() => {
    const map = new Map<string, ConfigItem[]>()
    for (const item of config.data?.items ?? []) {
      // 服务端没给分组就归到常规。
      const group = item.group || 'general'
      const list = map.get(group) ?? []
      list.push(item)
      map.set(group, list)
    }
    // 空的组不画。没有设置项的组对用户没有意义：上游的开关在「上游」页，
    // 配置页里剩下的多半是网关自己的设置，这一组经常是空的，画出来只是
    // 一个点不动的 tab。
    // 顺序：固定的那些按 GROUP_ORDER 走，数据里冒出来的组按出现的顺序
    // 接在后面。
    const known = GROUP_ORDER.filter((group) => map.has(group))
    const extra = [...map.keys()].filter((group) => !GROUP_ORDER.includes(group))
    return [...known, ...extra].map((group) => ({
      key: group,
      label: groupLabel(group),
      items: map.get(group) ?? [],
    }))
  }, [config.data])

  // 选中的那一组没了（比如重取之后分组变了），退回第一组。
  const activeTab = groups.some((group) => group.key === tab)
    ? tab
    : (groups[0]?.key ?? tab)

  if (config.isPending) {
    return <LoadingState />
  }
  if (config.isError) {
    return <ErrorState error={config.error} onRetry={() => config.refetch()} />
  }

  // 有改了还没生效的东西时，服务端说要重启。面板照它说，不自己猜：
  // 面板能改的那几个今天都是热的，但那是服务端的事。
  const pendingRestart = config.data?.pendingRestart ?? false
  const effectText = pendingRestart
    ? '改动会写进数据库，改完要重启才生效。被环境变量挡着的那些，等环境变量撤了才生效。'
    : '改动会写进数据库，改完立刻生效。'

  const save = async (key: string, value: string, clear: boolean) => {
    setBusy(true)
    try {
      const result = await setConfig.mutateAsync({ key, value, clear })
      setEditing(null)
      // 服务端会说明白这次改完是什么情况（比如被环境变量钉着），
      // 面板照它说，不自己猜。
      if (result.message) toast.success(result.message)
    } catch {
      // 失败时 api 层已经报过了。弹窗留着，用户还要改。
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell
      title='配置'
      description='各设置项当前生效的值，以及值的来源：环境变量、数据库覆盖或默认值。部署里钉住的（环境变量）说了算，面板写的值在库里等着。上游的开关在「上游」页。'
    >

      {groups.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState title='网关未返回任何配置项' />
          </CardContent>
        </Card>
      ) : (
        <Tabs value={activeTab} onValueChange={setTab}>
          <TabsList className='w-full justify-start overflow-x-auto'>
            {groups.map((group) => (
              <TabsTrigger key={group.key} value={group.key}>
                {group.label}
                <span className='text-xs text-muted-foreground'>
                  ({group.items.length})
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          {groups.map((group) => (
            <TabsContent key={group.key} value={group.key}>
              <Card>
                <CardHeader>
                  <CardTitle className='text-base'>{group.label}</CardTitle>
                  <CardDescription>{effectText}</CardDescription>
                </CardHeader>
                <CardContent className='px-0'>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>设置</TableHead>
                        <TableHead>当前值</TableHead>
                        <TableHead>来源</TableHead>
                        <TableHead className='text-right'>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.items.map((item) => (
                        <TableRow key={item.key}>
                          <TableCell>
                            <div className='grid gap-0.5'>
                              {/* 主要显示是给人看的名字，键名放次要位置。 */}
                              <span className='font-medium'>
                                {itemTitle(item)}
                              </span>
                              {showKey(item) ? (
                                <span className='font-mono text-xs text-muted-foreground'>
                                  {item.key}
                                </span>
                              ) : null}
                              {itemDescription(item) ? (
                                <span className='text-xs text-muted-foreground'>
                                  {itemDescription(item)}
                                </span>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell>
                            {item.secret ? (
                              // 敏感项的值读不出来，只说有没有。
                              <span className='text-xs'>
                                {hasValue(item) ? '已设置' : '未设置'}
                              </span>
                            ) : (
                              <span className='font-mono text-xs'>
                                {item.value || '—'}
                              </span>
                            )}
                            {item.fallback &&
                            item.fallback !== item.value ? (
                              <div className='text-xs text-muted-foreground'>
                                默认值 {item.fallback}
                              </div>
                            ) : null}
                            {item.overrideValue &&
                            item.overrideValue !== item.value ? (
                              // 面板写了、但环境变量在用：这份在库里等着。
                              <div className='text-xs text-muted-foreground'>
                                面板里的值 {item.overrideValue}
                                （环境变量在用，等它撤了才轮到这个）
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Badge variant='outline'>
                              {SOURCE_LABELS[item.source] ??
                                item.source ??
                                '未知'}
                            </Badge>
                          </TableCell>
                          <TableCell className='text-right'>
                            <div className='flex justify-end gap-2'>
                              <Button
                                variant='outline'
                                size='sm'
                                onClick={() => {
                                  setEditing({
                                    key: item.key,
                                    title: itemTitle(item),
                                    description: item.description,
                                    secret: item.secret,
                                  })
                                  // 敏感项的值读不出来，输入框一律从空开始。
                                  setDraft(item.secret ? '' : item.value)
                                }}
                              >
                                <Save />
                                改
                              </Button>
                              {item.source === 'database' ||
                              (item.overrideValue && item.overrideValue !== '') ? (
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  disabled={busy}
                                  onClick={() =>
                                    void save(item.key, '', true)
                                  }
                                >
                                  <RotateCcw />
                                  清回默认
                                </Button>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className='flex items-center gap-2'>
              {editing?.secret ? <KeyRound className='size-4' /> : null}
              {editing?.title ?? '改配置'}
            </DialogTitle>
            <DialogDescription>
              <span className='font-mono text-xs'>{editing?.key}</span>
              {editing?.description ? ` —— ${editing.description}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-2'>
            <Label htmlFor='config-value'>新值</Label>
            <Input
              id='config-value'
              value={draft}
              autoFocus
              type={editing?.secret ? 'password' : 'text'}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className='text-xs text-muted-foreground'>
              {editing?.secret
                ? '该项的值不可读取（只写不读）。留空表示不修改，填写新值即可更新。'
                : pendingRestart
                  ? '写入数据库后，重启才生效。'
                  : '写入数据库后立即生效。'}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setEditing(null)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (!editing) return
                if (editing.secret && draft.trim() === '') {
                  // 没填新值就别发请求：空串会被服务端当成「把密钥清空」。
                  toast('敏感项原样保留', { description: '未填写新值，未做修改。' })
                  setEditing(null)
                  return
                }
                void save(editing.key, draft, false)
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
