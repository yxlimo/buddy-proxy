import type { CreditLot } from '@/gen/buddy/admin/v1/admin_pb'
import { EmptyState } from '@/components/async-state'
import { StatusBadge } from '@/components/status-badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCny, formatDate, isFarFuture, remainingDays } from '@/lib/format'

/**
 * 赠金批次。
 *
 * 到期时间原样显示平台的日期：平台用 2099-12-31 标记「永不过期」，这里
 * 不翻译它。倒计时那一列对这种批次给「—」。
 */
export function CreditLotsTable({ lots }: { lots: CreditLot[] }) {
  if (lots.length === 0) {
    return (
      <EmptyState
        title='没有赠金批次'
        description='平台没有报任何一笔赠金。'
      />
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>批次</TableHead>
          <TableHead>来源</TableHead>
          <TableHead className='text-right'>剩余</TableHead>
          <TableHead>到期时间</TableHead>
          <TableHead>倒计时</TableHead>
          <TableHead>状态</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lots.map((lot) => (
          <CreditLotRow key={lot.id} lot={lot} />
        ))}
      </TableBody>
    </Table>
  )
}

function CreditLotRow({ lot }: { lot: CreditLot }) {
  const far = isFarFuture(lot.expiresAt)
  const days = remainingDays(lot.expiresAt)

  return (
    <TableRow>
      <TableCell>
        <span className='font-mono text-xs'>{lot.id}</span>
      </TableCell>
      <TableCell>{lot.sourceLabel || '—'}</TableCell>
      <TableCell className='text-right font-mono'>
        {formatCny(lot.remainingCny)}
      </TableCell>
      <TableCell className='font-mono text-xs'>
        {formatDate(lot.expiresAt)}
      </TableCell>
      <TableCell className='text-xs'>
        {far || days === null ? (
          '—'
        ) : days === 0 ? (
          <span className='text-destructive'>已到期</span>
        ) : (
          `${days} 天`
        )}
      </TableCell>
      <TableCell>
        <StatusBadge status={lot.status} />
      </TableCell>
    </TableRow>
  )
}
