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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ProviderKind } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 加一个 Provider。
 *
 * The id is the path segment clients use, so it has to be spelled out; the
 * alias is what the panel shows after the name, and it is how two accounts of
 * the same kind are told apart.
 */
export function AddProviderDialog({
  open,
  onOpenChange,
  kinds,
  onSubmit,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  kinds: ProviderKind[]
  onSubmit: (input: {
    id: string
    kind: string
    alias: string
    region: string
  }) => void
  pending: boolean
}) {
  const [kind, setKind] = useState('')
  const [id, setId] = useState('')
  const [alias, setAlias] = useState('')
  const [region, setRegion] = useState('')

  const chosen = kinds.find((k) => k.kind === kind)

  const reset = () => {
    setKind('')
    setId('')
    setAlias('')
    setRegion('')
  }

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
            添加 Provider
          </DialogTitle>
          <DialogDescription>
            同一类可以加很多个：它们各有各的凭据、自己的模型和自己的额度。唯一
            id 是客户端用的路径（/{'{id}'}/v1），也是客户端里那个 provider 的名字
            ；Provider 名称是显示给人看的。
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-3'>
          <div className='grid gap-2'>
            <Label htmlFor='provider-kind'>类型</Label>
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value)
                const k = kinds.find((x) => x.kind === value)
                // The id defaults to the kind, so the common case is one field.
                setId((old) => (old ? old : value))
                setAlias((old) => (old ? old : (k?.label ?? '')))
                setRegion(k?.regions?.[0] ?? '')
              }}
            >
              <SelectTrigger id='provider-kind'>
                <SelectValue placeholder='选一种上游' />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((k) => (
                  <SelectItem key={k.kind} value={k.kind}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='provider-id'>唯一 id（路径里用的）</Label>
            <Input
              id='provider-id'
              value={id}
              placeholder='minimax-api-token-plan'
              onChange={(event) => setId(event.target.value)}
              className='font-mono text-xs'
            />
            <p className='text-xs text-muted-foreground'>
              客户端里就叫这个：{'{router}'}/{id}/v1
            </p>
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='provider-alias'>Provider 名称</Label>
            <Input
              id='provider-alias'
              value={alias}
              placeholder='Token Plan'
              onChange={(event) => setAlias(event.target.value)}
            />
          </div>
          {chosen?.needsRegion ? (
            <div className='grid gap-2'>
              <Label htmlFor='provider-region'>区域</Label>
              <Select value={region} onValueChange={setRegion}>
                <SelectTrigger id='provider-region'>
                  <SelectValue placeholder='选一个区域' />
                </SelectTrigger>
                <SelectContent>
                  {(chosen.regions ?? []).map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
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
            disabled={pending || !kind || !id.trim()}
            onClick={() =>
              onSubmit({
                id: id.trim(),
                kind,
                alias: alias.trim(),
                region: region.trim(),
              })
            }
          >
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
