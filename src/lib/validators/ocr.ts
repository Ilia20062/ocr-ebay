import { z } from 'zod'

export const ocrReviewSchema = z.object({
  action: z.enum(['approve', 'override', 'discard']),
  manual_override: z.string().min(1).max(100).optional(),
}).refine(
  (data) => data.action !== 'override' || !!data.manual_override,
  { message: 'manual_override required when action is override' }
)

export type OcrReviewInput = z.infer<typeof ocrReviewSchema>
