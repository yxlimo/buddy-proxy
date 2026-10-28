import { useMemo } from 'react'
import { useUpstreams } from '@/features/upstreams/api'
import {
  UPSTREAM_STATE_HINTS,
  isUpstreamReady,
} from '@/features/upstreams/state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCount } from '@/lib/format'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'

type GroupPickerProps = {
  /** 存的是组名（上游 id），跟契约里 PublishedTarget.groupName 一个形状。 */
  value: string
  onChange: (value: string) => void
  id?: string
}

/**
 * 一行里说什么。
 *
 * 能用的上游只说模型数；不能用的把原因带上（冷却中、额度用完……），
 * 免得看着是同一个东西却不知道差别在哪。没有模型时说清楚没有。
 */
function optionText(upstream: Upstream): string {
  const label = upstream.label || upstream.id
  const models =
    upstream.modelCount > 0
      ? `${formatCount(upstream.modelCount)} 个模型`
      : '没有模型'
  if (isUpstreamReady(upstream.state)) {
    return `${label}（${models}）`
  }
  const hint = UPSTREAM_STATE_HINTS[upstream.state] ?? '现在不能用'
  return `${label}（${hint}，${models}）`
}

/**
 * 上游组下拉。
 *
 * 全部上游都列出来，能用的排前面。不能用的也选得到 —— 已经不可用的目标
 * 有时就是要改（换掉它、去掉它），选不到就改不了。
 * 能不能接由后端说（Upstream.state），面板不自己推断。
 *
 * 显示的是给人看的名字（上游的 label）加一句模型数；存的是组名。
 */
export function GroupPicker({ value, onChange, id }: GroupPickerProps) {
  const upstreams = useUpstreams()

  const all = upstreams.data?.upstreams ?? []
  const ordered = useMemo(() => {
    const ready = all.filter((u) => isUpstreamReady(u.state))
    const rest = all.filter((u) => !isUpstreamReady(u.state))
    return [...ready, ...rest]
  }, [all])

  // 草稿里的组现在指着一个上游：看它还能不能用。
  const selected = all.find((u) => u.id === value)
  // 草稿里的组指着的上游已经没了：留着它，用户看得见自己填的是啥，
  // 也方便换回去。
  const missing = value.trim() !== '' && selected === undefined

  if (upstreams.isPending) {
    return (
      <div className='grid gap-1'>
        <Select disabled value=''>
          <SelectTrigger id={id} className='w-full'>
            <SelectValue placeholder='正在加载上游…' />
          </SelectTrigger>
        </Select>
      </div>
    )
  }

  return (
    <div className='grid gap-1'>
      <Select
        value={value}
        onValueChange={onChange}
        disabled={all.length === 0}
      >
        <SelectTrigger id={id} className='w-full'>
          <SelectValue placeholder='选一个 Provider' />
        </SelectTrigger>
        <SelectContent>
          {missing ? (
            <SelectItem value={value}>{value}（没有这个 Provider）</SelectItem>
          ) : null}
          {ordered.map((upstream) => (
            <SelectItem
              key={upstream.id}
              value={upstream.id}
              className={
                isUpstreamReady(upstream.state)
                  ? undefined
                  : 'text-muted-foreground'
              }
            >
              {optionText(upstream)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {all.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          {'网关里一个上游都没有，先在 Provider 页登录并打开一个 Provider，才有组可以选。'}
        </p>
      ) : null}
      {missing ? (
        <p className='text-xs text-muted-foreground'>
          现在选的这个组不能用（上游列表里没有它），换一个吧。
        </p>
      ) : null}
    </div>
  )
}
