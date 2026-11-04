import { useEffect, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ProviderKeyLayout } from '@/features/accounts/provider-key-fields'

/**
 * 写凭据的弹窗。
 *
 * 弹窗按平台渲染带标签的格子：格子是什么由 provider-key-fields 那张表说，
 * 位置就是顺序（SetProviderKeys 的 keys[] 按位置读）。留空的那一格表示清掉它，
 * 所以空串也要发上去，不能滤掉 —— 全空提交就是清掉这些凭据。
 */
export function ProviderKeysDialog({
  open,
  onOpenChange,
  layout,
  onSubmit,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 这一类平台要填哪几格：位置就是顺序。null 表示这一类不用填 key。 */
  layout: ProviderKeyLayout | null
  onSubmit: (keys: string[]) => void
  pending: boolean
}) {
  // 每一格的值：下标就是位置。
  const [values, setValues] = useState<string[]>([])

  // 弹窗关掉的时候把填的值清掉：下次打开是空的，不是上一次填的那把。关掉有两
  // 条路（取消与保存成功），都走这一处。
  useEffect(() => {
    if (!open) setValues([])
  }, [open])

  // 这一类平台不用贴 key（凭据是登录会话）：没有弹窗。
  if (!layout) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <KeyRound className='size-4' />
            {layout.title}
          </DialogTitle>
          <DialogDescription>留空的格子表示清掉那一段。</DialogDescription>
        </DialogHeader>
        <div className='grid gap-3'>
          {layout.fields.map((field, index) => (
            <div className='grid gap-2' key={field.id}>
              <Label htmlFor={field.id}>{field.label}</Label>
              <Input
                id={field.id}
                type='password'
                placeholder={field.placeholder}
                value={values[index] ?? ''}
                onChange={(event) =>
                  setValues((prev) => {
                    const next = [...prev]
                    next[index] = event.target.value
                    return next
                  })
                }
                className='font-mono text-xs'
                autoComplete='off'
              />
              {field.hint ? (
                <p className='text-xs text-muted-foreground'>{field.hint}</p>
              ) : null}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              onSubmit(layout.fields.map((_, index) => values[index] ?? ''))
            }
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
