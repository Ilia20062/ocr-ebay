import { z } from 'zod'

export const MAX_IMAGES_PER_BATCH = 24

export const presignSchema = z.object({
  batch_id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']),
  file_size_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
})

export const confirmSchema = z.object({
  image_id: z.string().uuid(),
  batch_id: z.string().uuid(),
  storage_path: z.string().min(1),
  original_filename: z.string().optional(),
  file_size_bytes: z.number().int().optional(),
  mime_type: z.string().optional(),
})

export const batchReviewSchema = z
  .object({
    action: z.enum(['approve', 'override', 'discard']),
    manual_override: z.string().min(1).max(100).optional(),
  })
  .refine(
    (d) => d.action !== 'override' || !!d.manual_override,
    { message: 'manual_override required when action is override' },
  )

export type PresignInput = z.infer<typeof presignSchema>
export type ConfirmInput = z.infer<typeof confirmSchema>
export type BatchReviewInput = z.infer<typeof batchReviewSchema>
