import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * 写 API Key 的弹窗。
 *
 * MiniMax 开放平台一把 key 一个租户：所以这里填的是一把一把的 key，
 * 第一把是第一个租户。留空的行会被丢掉。
 */
export function ProviderKeysDialog({
  open,
  onOpenChange,
  existing,
  onSubmit,
  pending,
  /** 这把 key 是干什么的：开放平台是租户的 key，Code 网关是套餐的 key。 */
  kind,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 已经有的 key（掩码后的），只用来占位，不回显。 */
  existing: string[]
  onSubmit: (keys: string[]) => void
  pending: boolean
  kind?: string
}) {
  const [text, setText] = useState('')

  const keys = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setText('')
        onOpenChange(next)
      }}
    >
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <KeyRound className='size-4' />
            {kind === 'minimax' ? '套餐 key' : 'API Key'}
          </DialogTitle>
          <DialogDescription>
            {kind === 'minimax'
              ? '一把 coding plan 的 key（sk-cp-…），用来查这个账号的套餐额度。推理走的是登录会话，不用这把 key。'
              : '一行一把 key，按顺序排：第一把是第一个租户。填了 key 的租户会轮着接手请求，接不了的（套餐用完、被拒、被限流）就换下一把。'}
            {existing.length > 0
              ? ` 现在有 ${existing.length} 把，保存后会被这里填的替换。`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-2'>
          <Label htmlFor='provider-keys'>
            {kind === 'minimax' ? '套餐 key（一把）' : 'key（每行一把）'}
          </Label>
          <Textarea
            id='provider-keys'
            rows={5}
            placeholder='sk-cp-…'
            value={text}
            onChange={(event) => setText(event.target.value)}
            className='font-mono text-xs'
            autoComplete='off'
          />
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => {
              setText('')
              onOpenChange(false)
            }}
          >
            取消
          </Button>
          <Button
            disabled={pending || keys.length === 0}
            onClick={() => onSubmit(keys)}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
