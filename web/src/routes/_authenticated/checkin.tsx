import { createFileRoute } from '@tanstack/react-router'
import { CheckinPage } from '@/features/benefits/checkin-page'

export const Route = createFileRoute('/_authenticated/checkin')({
  component: CheckinPage,
})
