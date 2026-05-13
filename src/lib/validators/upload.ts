import { z } from 'zod'

// Image-count caps removed by request — there is no per-batch or per-session
// limit. Per-file size cap below remains (defensive bound on a single upload).
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

export const presignSchema = z.object({
  batch_id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']),
  file_size_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
})

export const createSessionSchema = z.object({
  lot_label: z.string().max(100).optional(),
})

export const sessionPresignSchema = z.object({
  filename: z.string().min(1).max(255),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']),
  file_size_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
})

export const sessionConfirmSchema = z.object({
  image_id: z.string().uuid(),
})

export const mergeBatchesSchema = z.object({
  batch_ids: z.array(z.string().uuid()).min(2),
})

export const splitBatchSchema = z.object({
  image_ids: z.array(z.string().uuid()).min(1),
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
