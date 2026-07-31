// Community access levels — a single global 5-level ladder (see
// docs/ACCESS_LEVELS.md). Definitions live here; per-member assignment is stored
// on community_members.level. Cumulative: a check is `level >= REQUIRED`.

export const LEVEL = {
  VIEWER:        0,
  HOUSEHOLD:     1,
  FAMILY_EDITOR: 2,
  ADMIN:         3,
  OWNER:         4,
} as const

export type Level = (typeof LEVEL)[keyof typeof LEVEL]

/** New members (signup/join) land here — full control of their own cluster. */
export const DEFAULT_LEVEL: Level = LEVEL.FAMILY_EDITOR

/** Highest level the owner may assign via the dashboard; OWNER is transfer-only. */
export const MAX_ASSIGNABLE_LEVEL: Level = LEVEL.ADMIN

export const LEVEL_NAMES: Record<number, string> = {
  0: 'Viewer',
  1: 'Household',
  2: 'Family Editor',
  3: 'Admin',
  4: 'Owner',
}
