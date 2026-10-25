import { useState } from 'react'
import { Check, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * 别名那一格。
 *
 * 点一下就能改：别名是分辨同一个平台下两个账号的办法。名字本身显示在账号那一
 * 列，这里只给一个铅笔（`iconOnly`）—— 不然同一个名字会在屏幕上出现两遍。
 */
export function ProviderAliasCell({
  providerId,
  alias,
  onSave,
  iconOnly = false,
}: {
  providerId: string
  alias: string
  onSave: (alias: string) => void
  /** 只画铅笔：名字在别处已经显示了。 */
  iconOnly?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(alias)

  if (!editing) {
    return (
      <Button
        variant='ghost'
        size={iconOnly ? 'icon-sm' : 'sm'}
        className={
          iconOnly ? undefined : 'h-7 px-2 text-xs text-muted-foreground'
        }
        aria-label={`改 ${providerId} 的别名`}
        onClick={() => {
          setText(alias)
          setEditing(true)
        }}
      >
        <Pencil className='size-3' />
        {iconOnly ? null : alias || '加名称'}
      </Button>
    )
  }

  return (
    <div className='flex items-center gap-1'>
      <Input
        autoFocus
        value={text}
        aria-label={`${providerId} 的别名`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onSave(text.trim())
            setEditing(false)
          }
          if (event.key === 'Escape') setEditing(false)
        }}
        className='h-7 w-32 text-xs'
      />
      <Button
        variant='ghost'
        size='icon-sm'
        aria-label='保存别名'
        onClick={() => {
          onSave(text.trim())
          setEditing(false)
        }}
      >
        <Check />
      </Button>
    </div>
  )
}
