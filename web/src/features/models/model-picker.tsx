import { useState } from 'react'
import { Check, ChevronDown, Loader2, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { useCatalogModels } from '@/features/models/catalog-api'
import { useUpstreams } from '@/features/upstreams/api'
import { UpstreamState } from '@/gen/buddy/admin/v1/admin_pb'

type ModelPickerProps = {
  /** 上游组名。选了它才去拉那个组的模型目录。 */
  groupName: string
  value: string
  onChange: (value: string) => void
  id?: string
  placeholder?: string
}

/**
 * 上游模型 id。
 *
 * 目录里有就下拉选（可以搜）；没有目录、或者用户就是想手填，退回输入框。
 */
export function ModelPicker({
  groupName,
  value,
  onChange,
  id,
  placeholder = '选一个上游模型',
}: ModelPickerProps) {
  const upstreams = useUpstreams()
  // 目录跟上游的开关有关（关着就不给模型），所以缓存键里带上状态。
  const state =
    upstreams.data?.upstreams.find((upstream) => upstream.id === groupName)
      ?.state ?? UpstreamState.UNSPECIFIED
  const catalog = useCatalogModels(groupName, state)
  const [open, setOpen] = useState(false)
  const [manual, setManual] = useState(false)

  const models = catalog.data?.models ?? []
  const hasCatalog = models.length > 0
  const loading = catalog.isPending && groupName.trim() !== ''

  // 目录里有这个模型吗？目录变了（比如换了组）但草稿里还留着旧值时，
  // 直接显示旧值，让用户看到。
  const known = models.some((model) => model.id === value)

  if (manual || (!loading && !hasCatalog)) {
    // 手填模式。退回手填要说清楚为什么，不要静悄悄地退化。
    return (
      <div className='grid gap-1'>
        <Input
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        {groupName.trim() === '' ? (
          <p className='text-xs text-muted-foreground'>
            先选 Provider 组，才有模型目录可选。
          </p>
        ) : loading ? (
          <p className='text-xs text-muted-foreground'>正在加载模型目录…</p>
        ) : catalog.isError ? (
          <p className='text-xs text-destructive'>
            取模型目录失败，手填一个上游模型 id。
          </p>
        ) : hasCatalog ? (
          // 目录是有的，是用户自己选了手填：给他一条回去的路。
          <div className='flex items-center gap-1'>
            <p className='text-xs text-muted-foreground'>
              这个上游有模型目录（{models.length} 个）。
            </p>
            <Button
              type='button'
              variant='link'
              size='sm'
              className='h-auto p-0 text-xs'
              onClick={() => setManual(false)}
            >
              回到下拉
            </Button>
          </div>
        ) : (
          <p className='text-xs text-muted-foreground'>
            这个上游没有目录，手填模型 id。
          </p>
        )}
      </div>
    )
  }

  return (
    <div className='grid gap-1'>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type='button'
            variant='outline'
            role='combobox'
            aria-expanded={open}
            className='w-full justify-between font-normal'
          >
            <span
              className={cn(
                'truncate',
                !value && 'text-muted-foreground'
              )}
            >
              {value || (loading ? '正在加载模型目录…' : placeholder)}
            </span>
            <ChevronDown className='size-4 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[--radix-popover-trigger-width] p-0'>
          <Command>
            <CommandInput placeholder='搜模型…' />
            <CommandList>
              <CommandEmpty>目录中没有匹配的模型。</CommandEmpty>
              <CommandGroup>
                {models.map((model) => (
                  <CommandItem
                    key={model.id}
                    value={model.id}
                    onSelect={() => {
                      onChange(model.id)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        'size-4',
                        value === model.id ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className='flex-1 truncate'>{model.id}</span>
                    {model.displayName && model.displayName !== model.id ? (
                      <span className='text-xs text-muted-foreground'>
                        {model.displayName}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <div className='flex items-center gap-2'>
        {loading ? <Loader2 className='size-3 animate-spin' /> : null}
        {known ? (
          <span className='text-xs text-muted-foreground'>
            目录里有这个模型。
          </span>
        ) : null}
        <Button
          type='button'
          variant='link'
          size='sm'
          className='h-auto p-0 text-xs'
          onClick={() => setManual(true)}
        >
          <Pencil className='size-3' />
          手填
        </Button>
      </div>
    </div>
  )
}
