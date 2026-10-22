import { createFileRoute } from '@tanstack/react-router'
import { UpstreamsPage } from '@/features/upstreams'

export const Route = createFileRoute('/_authenticated/upstreams')({
  component: UpstreamsPage,
})
