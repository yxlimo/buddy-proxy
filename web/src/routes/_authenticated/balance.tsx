import { createFileRoute } from '@tanstack/react-router'
import { BalancePage } from '@/features/balance'

export const Route = createFileRoute('/_authenticated/balance')({
  component: BalancePage,
})
