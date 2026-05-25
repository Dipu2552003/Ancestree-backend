import { z } from 'zod'

export const createRelationshipSchema = z.object({
  from_person_id: z.string().uuid(),
  to_person_id:   z.string().uuid(),
  rel_type:       z.enum(['PARENT_OF', 'SPOUSE_OF', 'SIBLING_OF']),
  sub_type:       z.enum([
    'biological', 'adopted', 'step',
    'married', 'partner', 'divorced',
    'full', 'half',
  ]).optional(),
  union_year: z.number().int().min(1000).max(2100).optional(),
}).refine(
  data => data.from_person_id !== data.to_person_id,
  { message: 'from_person_id and to_person_id must be different' }
)

export type CreateRelationshipInput = z.infer<typeof createRelationshipSchema>
