import { createFileRoute } from '@tanstack/react-router'
import { PublishedModelsPage } from '@/features/models'

export const Route = createFileRoute('/_authenticated/models')({
  component: PublishedModelsPage,
})
