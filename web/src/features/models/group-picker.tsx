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

type GroupPickerProps = {
  /** 存的是组名（上游 id），跟契约里 PublishedTarget.groupName 一个形状。 */
  value: string
  onChange: (value: string) => void
  id?: string
}

/**
 * 上游组下拉。
 *
 * 只列「能用」的上游：能不能接由后端说（Upstream.state 是 READY 才算）。
 * 其余的上游不列，但要说清楚为什么不能选。
 *
 * 显示的是给人看的名字（上游的 label）加一句模型数；存的是组名。
 */
export function GroupPicker({ value, onChange, id }: GroupPickerProps) {
  const upstreams = useUpstreams()

  const all = upstreams.data?.upstreams ?? []
  const ready = useMemo(() => all.filter((u) => isUpstreamReady(u.state)), [all])
  const unusable = useMemo(
    () => all.filter((u) => !isUpstreamReady(u.state)),
    [all]
  )

  // 草稿里的组现在不能用（比如上游被关了）：留着它，用户看得见自己填的是啥，
  // 也方便换回去。
  const stale = value.trim() !== '' && !ready.some((u) => u.id === value)

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
        disabled={ready.length === 0}
      >
        <SelectTrigger id={id} className='w-full'>
          <SelectValue placeholder='选一个 Provider' />
        </SelectTrigger>
        <SelectContent>
          {stale ? (
            <SelectItem value={value}>{value}（现在不能用）</SelectItem>
          ) : null}
          {ready.map((upstream) => (
            <SelectItem key={upstream.id} value={upstream.id}>
              {upstream.label || upstream.id}
              {upstream.modelCount > 0
                ? `（${formatCount(upstream.modelCount)} 个模型）`
                : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {ready.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          先在 Provider 页登录并打开一个 Provider，才有组可以选。
        </p>
      ) : null}
      {stale ? (
        <p className='text-xs text-muted-foreground'>
          现在选的这个组不能用（Provider 关着或者没登录），换一个吧。
        </p>
      ) : null}
      {/* 不能用的 Provider 不列，但说清楚为什么。 */}
      {unusable.length > 0 ? (
        <ul className='space-y-0.5 text-xs text-muted-foreground'>
          {unusable.map((upstream) => (
            <li key={upstream.id}>
              {`${upstream.label || upstream.id}：${UPSTREAM_STATE_HINTS[upstream.state] ?? '现在不能用'}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
