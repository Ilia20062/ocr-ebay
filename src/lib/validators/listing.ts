import { z } from 'zod'

export const createListingSchema = z.object({
  search_id: z.string().uuid(),
  title: z.string().min(1).max(80),
  description: z.string().max(4000).optional(),
  price: z.number().positive(),
  currency: z.string().length(3).default('USD'),
  quantity: z.number().int().positive().default(1),
  condition: z.string().min(1),
  category_id: z.string().min(1),
  fulfillment_policy_id: z.string().min(1),
  payment_policy_id: z.string().min(1),
  return_policy_id: z.string().min(1),
})

export const updateListingSchema = createListingSchema.partial().omit({ search_id: true })

export type CreateListingInput = z.infer<typeof createListingSchema>
export type UpdateListingInput = z.infer<typeof updateListingSchema>
