import { useState } from 'react'
import { Plus } from 'lucide-react'
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

/**
 * 在一个平台下加一个账号。
 *
 * 平台是代码里的模板（九个服务），加不了也删不掉；能加的是账号 —— 同一个平台
 * 下可以有好几个（主账号与 M plan、中转站的每个租户）。
 *
 * 别名可以不给：不给就由服务端起一个（「账号 2」这种）。
 */
export function AddAccountDialog({
  open,
  platform,
  platformLabel,
  onSubmit,
  onOpenChange,
  pending,
}: {
  open: boolean
  /** 在哪个平台下加：九个模板之一的 id。 */
  platform: string
  /** 这个平台叫什么，给人看。 */
  platformLabel: string
  onSubmit: (input: { platform: string; alias: string }) => void
  onOpenChange: (open: boolean) => void
  pending: boolean
}) {
  const [alias, setAlias] = useState('')

  const reset = () => setAlias('')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Plus className='size-4' />
            新增账号
          </DialogTitle>
          <DialogDescription>
            在「{platformLabel}」下加一个账号。账号各自有自己的凭据、自己的额度；
            客户端走的地址不变（/{platform}/v1），换的是这个平台下选了哪个账号
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-2'>
          <Label htmlFor='account-alias'>别名（可以不填）</Label>
          <Input
            id='account-alias'
            value={alias}
            placeholder='比如 主账号、M plan、租户一'
            onChange={(event) => setAlias(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              if (pending) return
              onSubmit({ platform, alias: alias.trim() })
            }}
          />
          <p className='text-xs text-muted-foreground'>
            别名只给面板看：同一个平台下两个账号靠它分辨。不填的话服务端起一个
          </p>
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => {
              reset()
              onOpenChange(false)
            }}
          >
            取消
          </Button>
          <Button
            disabled={pending}
            onClick={() => onSubmit({ platform, alias: alias.trim() })}
          >
            加上
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
