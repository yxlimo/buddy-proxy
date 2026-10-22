import { useMemo } from 'react'
import { useUpstreams } from '@/features/upstreams/api'
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
 * 只列「能用」的上游：开着、而且凭据是已登录的。没登录的、关掉的都不列 ——
 * 填了也接不了，不如先让用户去登录、去打开。
 *
 * 显示的是给人看的名字（上游的 label）加一句模型数；存的是组名。
 */
export function GroupPicker({ value, onChange, id }: GroupPickerProps) {
  const upstreams = useUpstreams()

  const usable = useMemo(
    () =>
      (upstreams.data?.upstreams ?? []).filter(
        (upstream) =>
          upstream.enabled && upstream.credential?.status === 'authenticated'
      ),
    [upstreams.data]
  )

  // 草稿里的组现在不能用（比如上游被关了）：留着它，用户看得见自己填的是啥，
  // 也方便换回去。
  const stale = value.trim() !== '' && !usable.some((u) => u.id === value)

  if (upstreams.isPending) {
    return (
      <div className='grid gap-1'>
        <Select disabled value=''>
          <SelectTrigger id={id} className='w-full'>
            <SelectValue placeholder='正在取上游…' />
          </SelectTrigger>
        </Select>
      </div>
    )
  }

  if (usable.length === 0 && !stale) {
    return (
      <div className='grid gap-1'>
        <Select disabled value=''>
          <SelectTrigger id={id} className='w-full'>
            <SelectValue placeholder='没有可用的上游' />
          </SelectTrigger>
        </Select>
        <p className='text-xs text-muted-foreground'>
          先在上游页登录并打开一个上游，才有组可以选。
        </p>
      </div>
    )
  }

  return (
    <div className='grid gap-1'>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className='w-full'>
          <SelectValue placeholder='选一个上游组' />
        </SelectTrigger>
        <SelectContent>
          {stale ? (
            <SelectItem value={value}>
              {value}（现在不能用）
            </SelectItem>
          ) : null}
          {usable.map((upstream) => (
            <SelectItem key={upstream.id} value={upstream.id}>
              {upstream.label || upstream.id}
              {upstream.modelCount > 0
                ? `（${formatCount(upstream.modelCount)} 个模型）`
                : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {stale ? (
        <p className='text-xs text-muted-foreground'>
          现在选的这个组不能用（上游关着或者没登录），换一个吧。
        </p>
      ) : null}
    </div>
  )
}
