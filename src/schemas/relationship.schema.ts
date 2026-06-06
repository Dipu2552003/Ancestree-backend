import { z } from 'zod'

// Sub-type semantics depend on rel_type:
//   PARENT_OF  : biological | adopted | step
//   SPOUSE_OF  : married | partner | divorced | widowed | separated | annulled | unknown
//   SIBLING_OF : full | half
// We accept the union in one schema and validate combinations at the service layer.
export const subTypeEnum = z.enum([
  // PARENT_OF
  'biological', 'adopted', 'step',
  // SPOUSE_OF
  'married', 'partner', 'divorced', 'widowed', 'separated', 'annulled', 'unknown',
  // SIBLING_OF
  'full', 'half',
])

export type SubType = z.infer<typeof subTypeEnum>

export const createRelationshipSchema = z.object({
  from_person_id:  z.string().uuid(),
  to_person_id:    z.string().uuid(),
  rel_type:        z.enum(['PARENT_OF', 'SPOUSE_OF', 'SIBLING_OF']),
  sub_type:        subTypeEnum.optional(),
  union_year:      z.number().int().min(1000).max(2100).optional(),
  separation_year: z.number().int().min(1000).max(2100).optional(),
}).refine(
  data => data.from_person_id !== data.to_person_id,
  { message: 'from_person_id and to_person_id must be different' }
)

// Statuses that mean "this marriage is currently active for layout purposes".
export const ACTIVE_SPOUSE_SUBTYPES = new Set<SubType>(['married', 'partner'])

// PATCH — used to change a marriage's status (e.g. married → divorced) or fix dates.
export const updateRelationshipSchema = z.object({
  sub_type:        subTypeEnum.optional(),
  union_year:      z.number().int().min(1000).max(2100).nullable().optional(),
  separation_year: z.number().int().min(1000).max(2100).nullable().optional(),
  notes:           z.string().max(2000).nullable().optional(),
})

export type CreateRelationshipInput = z.infer<typeof createRelationshipSchema>
export type UpdateRelationshipInput = z.infer<typeof updateRelationshipSchema>
