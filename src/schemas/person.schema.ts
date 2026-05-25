import { z } from 'zod'

export const createPersonSchema = z.object({
  full_name:        z.string().min(1).max(200),
  first_name:       z.string().max(100).nullish(),
  last_name:        z.string().max(100).nullish(),
  name_native:      z.string().max(200).nullish(),
  nickname:         z.string().max(100).nullish(),
  gender:           z.enum(['male', 'female', 'other', 'unknown']).nullish(),
  birth_year:       z.number().int().min(1000).max(2100).nullish(),
  birth_place:      z.string().max(200).nullish(),
  death_year:       z.number().int().min(1000).max(2100).nullish(),
  is_alive:         z.boolean().default(true),
  bio:              z.string().max(2000).nullish(),
  occupation:       z.string().max(200).nullish(),
  photo_url:        z.string().url().nullish().or(z.literal('')).or(z.literal(null)),
  visibility:       z.enum(['private', 'family', 'public']).default('family'),
  current_city:     z.string().max(100).nullish(),
  current_state:    z.string().max(100).nullish(),
  current_country:  z.string().max(100).nullish(),
  native_village:   z.string().max(100).nullish(),
  gotra:            z.string().max(100).nullish(),
  education:        z.string().max(200).nullish(),
})

export const updatePersonSchema = createPersonSchema.partial()

export type CreatePersonInput = z.infer<typeof createPersonSchema>
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>
