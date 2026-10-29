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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * 写 API Key 的弹窗。
 *
 * MiniMax 开放平台一把 key 一个租户：所以这里填的是一把一把的 key，
 * 第一把是第一个租户。留空的行会被丢掉。
 *
 * 七牛云是两段：推理用的 API Key，加上只用来查额度的门户 cookie。两段各有
 * 位置，空串表示清掉那一段，所以不能把空串丢掉。
 *
 * 讯飞星火只有一把推理用的 API Key：一把就够，填多把也只算第一把。空串表示清
 * 掉那把。
 */
export function ProviderKeysDialog({
  open,
  onOpenChange,
  existing,
  onSubmit,
  pending,
  /** 这把 key 是干什么的：开放平台是租户的 key。 */
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
  // 七牛的两段凭据。位置要留着：空串是「清掉这一段」，不是「不填」。
  const [apiKey, setApiKey] = useState('')
  const [cookie, setCookie] = useState('')
  // 讯飞星火的一把 key。
  const [xinghuoKey, setXinghuoKey] = useState('')

  const isQiniu = kind === 'qiniu'
  const isXinghuo = kind === 'xinghuo'

  const keys = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const reset = () => {
    setText('')
    setApiKey('')
    setCookie('')
    setXinghuoKey('')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <KeyRound className='size-4' />
            {isQiniu
              ? '七牛云凭据'
              : isXinghuo
                ? '讯飞星火 API Key'
                : 'API Key'}
          </DialogTitle>
          <DialogDescription>
            {isQiniu ? (
              <>
                推理 API Key 用来发模型请求；门户 Cookie 只用于查询资源包额度，可留空。在
                portal.qiniu.com 登录后从浏览器复制 Cookie，整串粘贴。留空表示清掉那一段。
              </>
            ) : isXinghuo ? (
              <>在讯飞星火控制台创建 API Key，整串粘贴。一把就够，填多把也只认第一把</>
            ) : (
              <>
                一行一把 key，按顺序排：第一把是第一个租户。填了 key 的租户会轮着接手请求，接不了的（套餐用完、被拒、被限流）就换下一把。
                {existing.length > 0
                  ? ` 现在有 ${existing.length} 把，保存后会被这里填的替换。`
                  : ''}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {isQiniu ? (
          <div className='grid gap-3'>
            <div className='grid gap-2'>
              <Label htmlFor='qiniu-api-key'>推理 API Key</Label>
              <Input
                id='qiniu-api-key'
                type='password'
                placeholder='sk-…'
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className='font-mono text-xs'
                autoComplete='off'
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='qiniu-cookie'>门户 Cookie</Label>
              <Input
                id='qiniu-cookie'
                type='password'
                placeholder='c=…'
                value={cookie}
                onChange={(event) => setCookie(event.target.value)}
                className='font-mono text-xs'
                autoComplete='off'
              />
            </div>
          </div>
        ) : isXinghuo ? (
          <div className='grid gap-2'>
            <Label htmlFor='xinghuo-api-key'>API Key</Label>
            <Input
              id='xinghuo-api-key'
              type='password'
              placeholder='在讯飞星火控制台复制的 API Key'
              value={xinghuoKey}
              onChange={(event) => setXinghuoKey(event.target.value)}
              className='font-mono text-xs'
              autoComplete='off'
            />
          </div>
        ) : (
          <div className='grid gap-2'>
            <Label htmlFor='provider-keys'>key（每行一把）</Label>
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
        )}
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
            disabled={pending || (!isQiniu && !isXinghuo && keys.length === 0)}
            onClick={() =>
              isQiniu
                ? onSubmit([apiKey, cookie])
                : isXinghuo
                  ? onSubmit([xinghuoKey.trim()])
                  : onSubmit(keys)
            }
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
