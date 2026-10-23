import { useState } from 'react'
import { create } from '@bufbuild/protobuf'
import { KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAdminClient } from '@/features/auth/client-provider'
import {
  setCandidateToken,
  setToken,
  useAdminToken,
} from '@/features/auth/use-admin-token'
import { GetSystemStatusRequestSchema } from '@/gen/buddy/admin/v1/admin_pb'
import { describeError } from '@/lib/errors'

/**
 * 令牌闸门。面板第一次打开时没有令牌，先问一句。
 *
 * 令牌是网关启动时在 /data/admin-token 生成的那一份（0600）。面板只把它
 * 放在浏览器 localStorage 里，不往外发。
 *
 * 填完先拿它去问网关一次（GetSystemStatus 很便宜），验过了才存：对就是
 * 对，错当场就知道，不会出现「填了 → 面板闪一下 → 又让我填」的情况。
 */
export function TokenGate({ children }: { children: React.ReactNode }) {
  const token = useAdminToken()
  const client = useAdminClient()
  const [draft, setDraft] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')

  if (token) {
    return <>{children}</>
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const value = draft.trim()
    if (!value || checking) return
    setChecking(true)
    setError('')
    setCandidateToken(value)
    try {
      await client.getSystemStatus(create(GetSystemStatusRequestSchema))
      // 验过了才存。
      setToken(value)
    } catch (reason) {
      setError(describeError(reason))
    } finally {
      setCandidateToken(null)
      setChecking(false)
    }
  }

  return (
    <div className='flex min-h-svh items-center justify-center bg-background p-6'>
      <Card className='w-full max-w-md'>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'>
            <KeyRound className='size-5' />
            输入访问令牌
          </CardTitle>
          <CardDescription>
            访问令牌在网关的 <code className='font-mono'>/data/admin-token</code>{' '}
            文件里。它与 agent 侧的 API KEY 是两回事，仅供面板使用。访问令牌会保存在
            这台机器的 localStorage 中。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className='grid gap-4'>
            <div className='grid gap-2'>
              <Label htmlFor='admin-token'>访问令牌</Label>
              <Input
                id='admin-token'
                type='password'
                autoFocus
                autoComplete='off'
                placeholder='粘贴 /data/admin-token 文件中的内容'
                value={draft}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'admin-token-error' : undefined}
                onChange={(event) => {
                  setDraft(event.target.value)
                  if (error) setError('')
                }}
              />
            </div>
            {error ? (
              <p
                id='admin-token-error'
                role='alert'
                className='text-sm text-destructive'
              >
                {error}
              </p>
            ) : null}
            <Button type='submit' disabled={!draft.trim() || checking}>
              {checking ? <Loader2 className='animate-spin' /> : null}
              {checking ? '正在验…' : '进入面板'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
