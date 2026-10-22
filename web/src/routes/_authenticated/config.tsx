import { createFileRoute } from '@tanstack/react-router'
import { ConfigPage } from '@/features/config'

export const Route = createFileRoute('/_authenticated/config')({
  component: ConfigPage,
})
