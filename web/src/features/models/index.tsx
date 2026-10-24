import { useState } from 'react'
import { create } from '@bufbuild/protobuf'
import { Pause, Pencil, Plus, Rocket, Trash2 } from 'lucide-react'
import {
  PublishedModelSchema,
  type PublishedModel,
} from '@/gen/buddy/admin/v1/admin_pb'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  useDeletePublishedModel,
  usePublishedModels,
  useSavePublishedModel,
} from '@/features/models/api'
import { UNPUBLISHED_REASON_LABELS } from '@/features/upstreams/state'
import { UnpublishedReason } from '@/gen/buddy/admin/v1/admin_pb'
import { ModelDialog } from '@/features/models/model-dialog'
import { formatCount, formatDate } from '@/lib/format'

export function PublishedModelsPage() {
  const models = usePublishedModels()
  const save = useSavePublishedModel()
  const remove = useDeletePublishedModel()

  const [editing, setEditing] = useState<PublishedModel | undefined>(undefined)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState<PublishedModel | undefined>(undefined)
  const [disabling, setDisabling] = useState<PublishedModel | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const openCreate = () => {
    setEditing(undefined)
    setDialogOpen(true)
  }

  const openEdit = (model: PublishedModel) => {
    setEditing(model)
    setDialogOpen(true)
  }

  const submit = async (model: PublishedModel) => {
    setBusy(true)
    try {
      await save.mutateAsync(model)
      // 只有真的存成了才关弹窗。失败时 api 层已经报过错，弹窗留着，
      // 用户填的 id 和目标都还在。
      setDialogOpen(false)
    } catch {
      // 失败：不动弹窗。
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await remove.mutateAsync({ id: deleting.id })
      setDeleting(undefined)
    } catch {
      // 失败：对话框留着。
    } finally {
      setBusy(false)
    }
  }

  /**
   * 发布或者停用。
   *
   * 就是把这个模型原样再存一遍，只改 enabled —— 别的字段一个都不动。
   */
  const setEnabled = async (model: PublishedModel, enabled: boolean) => {
    setBusy(true)
    try {
      await save.mutateAsync(
        create(PublishedModelSchema, { ...model, enabled })
      )
    } catch {
      // 失败：api 层已经报过了。
    } finally {
      setBusy(false)
    }
  }

  if (models.isPending) {
    return <LoadingState />
  }
  if (models.isError) {
    return <ErrorState error={models.error} onRetry={() => models.refetch()} />
  }

  const list = models.data.models
  // 根路由现在真的公布了几个：模型在库里不等于公布了（上游全关着、
  // 目标模型上游没了，就没人能接）。
  const publishedCount = list.filter((model) => model.published).length

  return (
    <PageShell
      title='主路由模型'
      description='主路由：对外公布一个模型 id，可挂载多个 Provider 的模型，客户端仅看到公布的这一层。'
      actions={
        <Button onClick={openCreate}>
          <Plus />
          新建
        </Button>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>主路由模型</CardTitle>
          <CardDescription>
            <span>
              根路由当前公布 {publishedCount} 个（共 {list.length} 个）。
            </span>{' '}
            各目标的请求量为网关运行统计。
          </CardDescription>
        </CardHeader>
        <CardContent className='px-0'>
          {list.length === 0 ? (
            <EmptyState
              title='暂无主路由模型'
              description='根路由仅服务此处公布的模型。'
              action={
                <Button onClick={openCreate}>
                  <Plus />
                  新建一个
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>对外 id</TableHead>
                  <TableHead>显示名</TableHead>
                  <TableHead>策略</TableHead>
                  <TableHead>上下文 / 输出 token</TableHead>
                  <TableHead>Provider 目标</TableHead>
                  <TableHead className='text-right'>请求</TableHead>
                  <TableHead className='text-right'>更新时间</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((model) => (
                  <TableRow key={model.id}>
                    <TableCell>
                      <div className='grid gap-0.5'>
                        <span className='font-mono text-xs font-medium'>
                          {model.id}
                        </span>
                        <div className='flex flex-wrap gap-1'>
                          {!model.enabled ? (
                            <Badge variant='secondary'>已停用</Badge>
                          ) : null}
                          {/* 库里有不等于根路由公布了：上游关着、或者目标
                              模型的上游没了，都没人能接。published 说
                              有没有，unpublishedReason 说为什么。 */}
                          {model.published ? null : (
                            <Badge
                              variant='outline'
                              title='根路由当前未公布该模型。发布操作无法改变这一点，需要先启用并登录对应 Provider。'
                            >
                              {`未公布：${UNPUBLISHED_REASON_LABELS[model.unpublishedReason ?? UnpublishedReason.UNSPECIFIED] ?? '原因未知'}`}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{model.displayName || '—'}</TableCell>
                    <TableCell>
                      <Badge variant='outline'>
                        {model.strategy === 'fallback' ? 'fallback' : 'single'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {/* 继承之后的值：没填就是跟着目标走，目标之间不一致
                          时取最小的那个。库里存的是另一样东西（effective
                          那个字段是现算的）。 */}
                      <span className='font-mono text-xs'>
                        {model.effective?.contextWindow
                          ? formatCount(model.effective.contextWindow)
                          : '继承'}
                        {' / '}
                        {model.effective?.maxOutputTokens
                          ? formatCount(model.effective.maxOutputTokens)
                          : '继承'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className='grid gap-1'>
                        {model.targets.length === 0 ? (
                          <span className='text-xs text-muted-foreground'>
                            没有目标
                          </span>
                        ) : (
                          model.targets.map((target) => (
                            <div
                              key={`${target.groupName}-${target.upstreamModel}`}
                              className='grid gap-0.5'
                            >
                              <span className='max-w-[200px] font-mono text-xs break-all'>
                                {target.groupName} → {target.upstreamModel}
                              </span>
                              <span className='text-xs text-muted-foreground'>
                                {formatCount(target.requests)} 次
                                {target.failed > 0n
                                  ? ` · 失败 ${formatCount(target.failed)}`
                                  : ''}
                                {!target.enabled ? ' · 已停用' : ''}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className='text-right font-mono'>
                      {formatCount(
                        model.targets.reduce(
                          (sum, target) => sum + target.requests,
                          0n
                        )
                      )}
                    </TableCell>
                    <TableCell className='text-right text-xs text-muted-foreground'>
                      {formatDate(model.updatedAt)}
                    </TableCell>
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        {model.enabled ? (
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={busy}
                            onClick={() => setDisabling(model)}
                          >
                            <Pause />
                            停用
                          </Button>
                        ) : (
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={busy}
                            onClick={() => void setEnabled(model, true)}
                          >
                            <Rocket />
                            发布
                          </Button>
                        )}
                        <Button
                          variant='outline'
                          size='icon'
                          title='改'
                          aria-label='改'
                          onClick={() => openEdit(model)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant='ghost'
                          size='icon'
                          title='删'
                          aria-label='删'
                          onClick={() => setDeleting(model)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ModelDialog
        open={dialogOpen}
        model={editing}
        busy={busy}
        onOpenChange={setDialogOpen}
        onSubmit={(model) => void submit(model)}
      />

      <Dialog
        open={disabling !== undefined}
        onOpenChange={(open) => {
          if (!open) setDisabling(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认停用该模型？</DialogTitle>
            <DialogDescription>
              <span className='font-mono'>{disabling?.id}</span>{' '}
              停用后根路由不再公布该模型，客户端将无法看到。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDisabling(undefined)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              onClick={() => {
                const model = disabling
                if (!model) return
                setDisabling(undefined)
                void setEnabled(model, false)
              }}
              disabled={busy}
            >
              停用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除该模型？</DialogTitle>
            <DialogDescription>
              <span className='font-mono'>{deleting?.id}</span>{' '}
              删除后客户端将无法看到该模型。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDeleting(undefined)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              variant='destructive'
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              删掉
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
