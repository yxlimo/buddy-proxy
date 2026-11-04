import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useDeletePlatform } from '@/features/open-platforms/api'
import { modelsReferencingPlatform } from '@/features/open-platforms/platform-references'
import {
  useDeletePublishedModel,
  usePublishedModels,
} from '@/features/models/api'
import { describeError } from '@/lib/errors'
import type { PublishedModel, Upstream } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 删掉一个开放平台：先扫一遍主路由模型。
 *
 * 删平台之前要知道有没有主路由模型指着它：那些模型的目标就是这个平台，平台
 * 没了它们就再也接不了（面板上显示「平台已停用」）。所以扫到有模型指着它时，
 * 弹框里把它们列出来，确认之后先删这些模型、再删平台。
 *
 * 扫的那份列表是异步来的：还没扫完不给删，扫不到也不给删 —— 那时面板不知道
 * 有没有模型指着它，删了就是闭着眼删。
 */
export function DeletePlatformButton({ platform }: { platform: Upstream }) {
  const published = usePublishedModels()
  const deleteModel = useDeletePublishedModel()
  const deletePlatform = useDeletePlatform()

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 这一轮删到哪儿出的错：显示在弹框里，不吞掉。 */
  const [error, setError] = useState<string | null>(null)
  /**
   * 还没删掉的那几个主路由模型。
   *
   * 存的是「还没删的」，不是「扫到的全部」：删掉一个就少一个。重试时只删
   * 剩下的那几个 —— 已经删掉的那些服务端已经没有，再删一次只会一直失败。
   */
  const [pending, setPending] = useState<PublishedModel[]>([])
  /**
   * 这个平台上已经删成功的那些主路由模型（id）。
   *
   * 扫到的那份名单是缓存来的：删掉模型之后要重取一趟才回来，那之前名单里
   * 还带着已经删掉的模型。用户取消之后又点开弹框，队列要是照抄那份名单，
   * 重试就会先去删一个已经不存在的 —— 服务端说「没有这个模型」，于是平台
   * 一直删不掉。
   *
   * 记着删成功过的那些，队列里就不带它们了。这份记忆只对当前这个平台实例
   * 有效（页面刷新就没了，那时名单也重取回来了，一样是对的）。
   */
  const [removed, setRemoved] = useState<string[]>([])

  // 扫主路由模型：还没扫完不给删，扫不到也不给删。
  // 后台重取失败同样算「扫不到」：那份旧数据说不准现在还有没有模型指着它。
  const scanFailed = published.isError
  const scanned = published.isSuccess
  const referencing = scanned
    ? modelsReferencingPlatform(published.data.models, platform.id)
    : []

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    // 这一轮要删的：还没删的那几个。
    const queue = pending
    const deleted: string[] = []
    let failure: string | null = null
    for (const model of queue) {
      try {
        await deleteModel.mutateAsync({ id: model.id })
        deleted.push(model.id)
      } catch (e) {
        failure = describeError(e)
        break
      }
    }
    // 已经删掉的那些从队列里去掉：重试时不再去动它们。
    setPending(queue.filter((model) => !deleted.includes(model.id)))
    // 也记下来：下一次开这个弹框时，队列里不再有它们（扫到的那份是缓存，
    // 还带着已经删掉的那些）。
    if (deleted.length > 0) {
      setRemoved((prev) => [...prev, ...deleted])
    }
    if (failure !== null) {
      // 停在半路：平台不删（删了会留下更多接不了的模型）。
      // 已经删掉的那几个不回滚 —— 回不来，也不该回滚。
      setError(`主路由模型没删掉，平台没删：${failure}`)
      setBusy(false)
      return
    }
    // 模型都删干净了，现在删平台。
    deletePlatform.mutate({ id: platform.id })
    setBusy(false)
    setOpen(false)
  }

  return (
    <>
      {/* 为什么现在不能删，写在按钮下面：禁用的按钮收不到鼠标事件，挂在
          外面那个 span 上才看得见。 */}
      <span className='inline-flex flex-col items-end gap-0.5'>
        <Button
          size='sm'
          variant='outline'
          className='text-destructive'
          disabled={!scanned}
          onClick={() => {
            setError(null)
            // 队列 = 扫到的那些里还没删掉的。已经删成功过的那些不再回来：
            // 扫到的是缓存，重取要一个来回，那之前它还带着已经删掉的模型。
            setPending(referencing.filter((model) => !removed.includes(model.id)))
            setOpen(true)
          }}
        >
          删掉
        </Button>
        {!scanned && !scanFailed ? (
          <span className='text-xs text-muted-foreground'>
            还在查哪些主路由模型指向它
          </span>
        ) : null}
        {scanFailed ? (
          <span className='flex items-center gap-1'>
            <span className='max-w-64 text-xs text-destructive'>
              {`查不到主路由模型：${describeError(published.error)}`}
            </span>
            {/* 扫不到时可以再扫一次：同页上游列表取不到时也有这个入口，
                这里不能只让用户刷新整页。 */}
            <Button
              size='xs'
              variant='outline'
              onClick={() => {
                void published.refetch()
              }}
            >
              重试
            </Button>
          </span>
        ) : null}
      </span>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setOpen(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              删掉 {platform.label || platform.id}
            </AlertDialogTitle>
            <AlertDialogDescription>
              这个平台会删掉，名下的账号、凭据、额度、冷却一起清掉，删完回不来。客户端走这个平台的地址也就不通了
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending.length > 0 ? (
            <div className='grid gap-1'>
              <p className='text-sm font-medium'>
                这些主路由模型会一起删掉：
              </p>
              <ul className='grid gap-0.5'>
                {pending.map((model) => (
                  <li key={model.id} className='text-xs'>
                    <span className='font-mono'>{model.id}</span>
                    {model.displayName ? (
                      <span className='text-muted-foreground'>
                        {` · ${model.displayName}`}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {error ? <p className='text-sm text-destructive'>{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            {/* 确认按钮不用 AlertDialogAction：那个点了就关弹框，这一轮删到
                哪儿、失败没有，还得留在弹框里说。 */}
            <Button
              variant='destructive'
              disabled={busy}
              onClick={() => {
                void confirm()
              }}
            >
              删掉
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
