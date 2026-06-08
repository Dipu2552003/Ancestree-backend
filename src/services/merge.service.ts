/**
 * MERGE SERVICE — five operations
 *
 * Operation 1  searchDuplicates   — exact-name search across all families
 * Operation 2  createMergeRequest — create merge_records row + notify target family
 * Operation 3  acceptMerge        — atomic transaction: redirect rels, soft-delete dup, notify
 * Operation 4  rejectMerge        — mark rejected + notify initiator
 * Operation 5  (called internally) recomputeFamilyHead — in familyHead.service.ts
 */

import pool, { query } from '../utils/db'
import { createNotification, notifyFamily } from './notification.service'
import { recomputeFamilyHead } from './familyHead.service'
import { detectMergeConflicts, type MergeConflict, type ConflictContext } from './mergeConflicts.service'
import { logger } from '../utils/logger'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SentMergeRequest {
  id:                    string
  status:                'proposed' | 'confirmed' | 'rejected' | 'reversed'
  canonical_person_name: string
  canonical_family_name: string
  merged_person_name:    string
  created_at:            string
  merged_at:             string | null
}

export interface SearchInput {
  fullName:       string
  firstName?:     string | null
  lastName?:      string | null
  birthYear?:     number | null
  nativeVillage?: string | null
  gotra?:         string | null
  gender?:        string | null
}

export interface PotentialMatch {
  id:             string
  full_name:      string
  birth_year:     number | null
  native_village: string | null
  current_city:   string | null
  gotra:          string | null
  gender:         string | null
  photo_url:      string | null
  father_name:    string | null
  family_name:    string
  family_id:      string
  member_count:   number
  match_score:    number
  matched_fields: string[]
}

interface DBCandidate {
  id:             string
  full_name:      string
  first_name:     string | null
  last_name:      string | null
  birth_year:     number | null
  native_village: string | null
  current_city:   string | null
  gotra:          string | null
  gender:         string | null
  photo_url:      string | null
  father_name:    string | null
  family_name:    string
  family_id:      string
  member_count:   number
}

function norm(s: string | null | undefined) {
  return (s ?? '').trim().toLowerCase()
}

function scoreCandidate(c: DBCandidate, input: SearchInput): { score: number; matched: string[] } {
  let score = 0
  const matched: string[] = []

  if (norm(c.full_name) === norm(input.fullName) && norm(input.fullName)) {
    score += 50
    matched.push('name')
  } else {
    if (norm(input.firstName) && norm(c.first_name) && norm(c.first_name) === norm(input.firstName)) {
      score += 20
      matched.push('first name')
    }
    if (norm(input.lastName) && norm(c.last_name) && norm(c.last_name) === norm(input.lastName)) {
      score += 15
      matched.push('last name')
    }
  }

  if (input.birthYear && c.birth_year) {
    const diff = Math.abs(input.birthYear - c.birth_year)
    if (diff === 0)      { score += 30; matched.push('birth year') }
    else if (diff <= 2)  { score += 15; matched.push('approx. birth year') }
  }

  if (norm(input.nativeVillage) && norm(c.native_village) && norm(c.native_village) === norm(input.nativeVillage)) {
    score += 20
    matched.push('village')
  }

  if (norm(input.gotra) && norm(c.gotra) && norm(c.gotra) === norm(input.gotra)) {
    score += 15
    matched.push('gotra')
  }

  if (input.gender && c.gender && input.gender === c.gender) score += 5

  return { score, matched }
}

// ── Operation 1 ───────────────────────────────────────────────────────────────

/**
 * Multi-field scored search across all families except the caller's.
 * Matches on name, birth year, village, gotra — returns scored + ranked results.
 */
export async function searchDuplicates(
  input: SearchInput,
  callerFamilyId: string,
): Promise<PotentialMatch[]> {
  // Build OR conditions dynamically based on available fields
  const orConditions: string[] = []
  const params: (string | number)[] = [callerFamilyId]
  let idx = 2

  orConditions.push(`LOWER(p.full_name) = LOWER($${idx++})`)
  params.push(input.fullName)

  if (input.firstName?.trim()) {
    orConditions.push(`(p.first_name IS NOT NULL AND LOWER(p.first_name) = LOWER($${idx++}))`)
    params.push(input.firstName.trim())
  }

  if (input.lastName?.trim()) {
    orConditions.push(`(p.last_name IS NOT NULL AND LOWER(p.last_name) = LOWER($${idx++}))`)
    params.push(input.lastName.trim())
  }

  const { rows } = await query<DBCandidate>(
    `SELECT p.id, p.full_name, p.first_name, p.last_name,
            p.birth_year, p.native_village, p.current_city,
            p.gotra, p.gender, p.photo_url,
            f.name AS family_name, f.id AS family_id,
            father.full_name AS father_name,
            (SELECT COUNT(*) FROM family_members fm WHERE fm.family_id = f.id)::int AS member_count
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id
     LEFT JOIN LATERAL (
       SELECT fp.full_name
       FROM   relationships fr
       JOIN   persons fp ON fp.id = fr.from_person_id AND fp.deleted_at IS NULL
       WHERE  fr.to_person_id = p.id
         AND  fr.rel_type     = 'PARENT_OF'
         AND  fr.deleted_at IS NULL
       ORDER BY (fp.gender = 'male') DESC NULLS LAST, fp.person_code
       LIMIT 1
     ) father ON true
     WHERE  p.deleted_at        IS NULL
       AND  p.primary_family_id != $1
       AND  f.deleted_at        IS NULL
       AND  (${orConditions.join(' OR ')})
     LIMIT  30`,
    params,
  )

  return rows
    .map(c => {
      const { score, matched } = scoreCandidate(c, input)
      return {
        id:             c.id,
        full_name:      c.full_name,
        birth_year:     c.birth_year,
        native_village: c.native_village,
        current_city:   c.current_city,
        gotra:          c.gotra,
        gender:         c.gender,
        photo_url:      c.photo_url,
        father_name:    c.father_name,
        family_name:    c.family_name,
        family_id:      c.family_id,
        member_count:   c.member_count,
        match_score:    score,
        matched_fields: matched,
      }
    })
    .filter(m => m.match_score >= 20)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 5)
}

// ── Operation 1b — List sent requests ─────────────────────────────────────────

export async function listSentMergeRequests(
  userId: string,
): Promise<SentMergeRequest[]> {
  const { rows } = await query<SentMergeRequest>(
    `SELECT
       mr.id,
       mr.status,
       mr.created_at,
       mr.merged_at,
       cp.full_name  AS canonical_person_name,
       cf.name       AS canonical_family_name,
       mp.full_name  AS merged_person_name
     FROM   merge_records mr
     JOIN   persons  cp ON cp.id = mr.canonical_person_id
     JOIN   families cf ON cf.id = cp.primary_family_id
     JOIN   persons  mp ON mp.id = mr.merged_person_id
     WHERE  mr.initiated_by = $1
     ORDER  BY mr.created_at DESC
     LIMIT  50`,
    [userId],
  )
  return rows
}

// ── Operation 2 ───────────────────────────────────────────────────────────────

/**
 * Create a merge request.
 *   newPersonId      — the just-created node in the initiator's family
 *   canonicalPersonId — the existing node in the other family
 *   initiatedBy      — userId who clicked "Send Request"
 *   initiatorFamilyId — their family
 */
export async function createMergeRequest(
  newPersonId:       string,
  canonicalPersonId: string,
  initiatedBy:       string,
  initiatorFamilyId: string,
): Promise<{ merge_record_id: string }> {
  // Verify the person being proposed belongs to the initiator's own family
  const { rows: [personCheck] } = await query(
    `SELECT id FROM persons
     WHERE  id = $1 AND primary_family_id = $2 AND deleted_at IS NULL`,
    [newPersonId, initiatorFamilyId],
  )
  if (!personCheck) {
    throw { status: 403, message: 'You can only request merges for persons in your own family' }
  }

  // Prevent duplicate pending requests for the same pair
  const { rows: existing } = await query(
    `SELECT id FROM merge_records
     WHERE  merged_person_id    = $1
       AND  canonical_person_id = $2
       AND  status              = 'proposed'`,
    [newPersonId, canonicalPersonId],
  )
  if (existing.length > 0) {
    return { merge_record_id: existing[0].id as string }
  }

  const { rows: [record] } = await query<{ id: string }>(
    `INSERT INTO merge_records
       (canonical_person_id, merged_person_id, initiated_by, status)
     VALUES ($1, $2, $3, 'proposed')
     RETURNING id`,
    [canonicalPersonId, newPersonId, initiatedBy],
  )
  const mergeRecordId = record.id

  // Fetch person names for the notification message
  const { rows: persons } = await query<{ id: string; full_name: string; primary_family_id: string }>(
    `SELECT id, full_name, primary_family_id FROM persons WHERE id = ANY($1::uuid[])`,
    [[newPersonId, canonicalPersonId]],
  )
  const canonPerson = persons.find(p => p.id === canonicalPersonId)
  const newPerson   = persons.find(p => p.id === newPersonId)
  if (!canonPerson || !newPerson) {
    throw { status: 404, message: 'One or more persons not found' }
  }

  const { rows: [initiatorFamily] } = await query<{ name: string }>(
    `SELECT name FROM families WHERE id = $1`,
    [initiatorFamilyId],
  )

  const message =
    `"${initiatorFamily.name}" believes their "${newPerson.full_name}" ` +
    `is the same person as your "${canonPerson.full_name}". Accept or Reject?`

  // If the canonical node is claimed, only the claimant is the decision-maker.
  // Otherwise fan out to family members; include the initiator on same-family
  // merges so the only real user in their own tree still gets the notification.
  const { rows: [claimant] } = await query<{ id: string }>(
    `SELECT id FROM users WHERE person_id = $1 LIMIT 1`,
    [canonicalPersonId],
  )
  if (claimant) {
    await createNotification(
      claimant.id,
      'merge_request_received',
      message,
      mergeRecordId,
    )
  } else {
    const isSameFamily = canonPerson.primary_family_id === initiatorFamilyId
    await notifyFamily(
      canonPerson.primary_family_id,
      'merge_request_received',
      message,
      mergeRecordId,
      isSameFamily ? [] : [initiatedBy],
    )
  }

  logger.info({ mergeRecordId, newPersonId, canonicalPersonId, initiatedBy, initiatorFamilyId }, 'merge request created')
  return { merge_record_id: mergeRecordId }
}

// ── Operation 3 ───────────────────────────────────────────────────────────────

/**
 * Accept a merge request. Runs as a single database transaction.
 * The canonical node survives; the merged (newly-created) node is soft-deleted.
 */
export async function acceptMerge(
  mergeRecordId: string,
  acceptedBy:    string,
): Promise<{ canonical_person_id: string; conflicts: MergeConflict[] }> {
  const client = await pool.connect()
  let canonicalId = ''
  let canonFamilyId = ''
  let mergedFamilyId = ''

  logger.info({ mergeRecordId, acceptedBy }, 'merge accept: start')
  try {
    await client.query('BEGIN')

    // Step 1: Validate — record must exist and be proposed
    const { rows: [record] } = await client.query<{
      id: string; canonical_person_id: string; merged_person_id: string; initiated_by: string
    }>(
      `SELECT id, canonical_person_id, merged_person_id, initiated_by
       FROM merge_records WHERE id = $1 AND status = 'proposed'`,
      [mergeRecordId],
    )
    if (!record) throw { status: 404, message: 'Merge request not found or already resolved' }

    canonicalId = record.canonical_person_id
    const deletedId  = record.merged_person_id
    const initiatedBy = record.initiated_by

    // Step 2: Verify acceptor is member of canonical family
    const { rows: [canonPerson] } = await client.query<{
      id: string; full_name: string; primary_family_id: string
    }>(
      `SELECT id, full_name, primary_family_id FROM persons WHERE id = $1`,
      [canonicalId],
    )
    const { rows: [mergedPerson] } = await client.query<{
      id: string; full_name: string; primary_family_id: string
    }>(
      `SELECT id, full_name, primary_family_id FROM persons WHERE id = $1`,
      [deletedId],
    )

    canonFamilyId  = canonPerson.primary_family_id
    mergedFamilyId = mergedPerson.primary_family_id

    // If the canonical node is claimed, only the claimant can accept.
    // Otherwise any member of the canonical family can accept.
    const { rows: [canonClaimant] } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE person_id = $1 LIMIT 1`,
      [canonicalId],
    )
    if (canonClaimant) {
      if (canonClaimant.id !== acceptedBy) {
        throw { status: 403, message: 'Only the claimed owner of this node can accept this merge' }
      }
    } else {
      const { rows: [membership] } = await client.query(
        `SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2`,
        [canonFamilyId, acceptedBy],
      )
      if (!membership) throw { status: 403, message: 'You are not a member of the target family' }
    }

    // Capture every user who was a member of either family BEFORE mutations.
    // The safety net at the end of the transaction restores any that lost
    // their last active membership (defence-in-depth for any future regression
    // in the family-teardown steps).
    const { rows: preMergeMembers } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM family_members WHERE family_id = ANY($1::uuid[])`,
      [[canonFamilyId, mergedFamilyId]],
    )
    const preMergeUserIds = preMergeMembers.map(r => r.user_id)

    // Step 3: Redirect all relationships from deleted node → canonical node
    await client.query(
      `UPDATE relationships SET from_person_id = $1
       WHERE  from_person_id = $2 AND deleted_at IS NULL`,
      [canonicalId, deletedId],
    )
    await client.query(
      `UPDATE relationships SET to_person_id = $1
       WHERE  to_person_id = $2 AND deleted_at IS NULL`,
      [canonicalId, deletedId],
    )

    // Step 4: Remove exact duplicates created by the redirect
    await client.query(
      `DELETE FROM relationships
       WHERE id IN (
         SELECT r1.id
         FROM   relationships r1
         WHERE  r1.deleted_at IS NULL
           AND  EXISTS (
             SELECT 1 FROM relationships r2
             WHERE  r2.from_person_id = r1.from_person_id
               AND  r2.to_person_id   = r1.to_person_id
               AND  r2.rel_type       = r1.rel_type
               AND  r2.id             != r1.id
               AND  r2.deleted_at IS NULL
               AND  r2.created_at     < r1.created_at
           )
       )`,
    )

    // ── Capture merge context (must happen BEFORE step 5d moves all relationships
    //    to canonFamilyId, after which old vs new are indistinguishable) ─────────
    //
    // "New" = came from the merged family.  Used by step 5f to infer the
    // relationships that must exist in the canonical family but don't yet:
    //
    //   Case 1  New children  + existing spouses  →  spouse PARENT_OF new child
    //   Case 2  New children  + existing children →  SIBLING_OF between them
    //   Case 2b New children  + new children      →  SIBLING_OF between them
    //   Case 3  New spouses   + existing children →  new spouse PARENT_OF child
    //   Case 4  New siblings  + existing parents  →  parent PARENT_OF new sibling
    //   Case 5  New siblings  + existing siblings →  SIBLING_OF between them
    //   Case 5b New siblings  + new siblings      →  SIBLING_OF between them
    //   Case 6  New parents   + existing siblings →  new parent PARENT_OF existing sibling

    const { rows: newChildRows } = await client.query<{ child_id: string }>(
      `SELECT to_person_id AS child_id
       FROM   relationships
       WHERE  from_person_id    = $1
         AND  rel_type          = 'PARENT_OF'
         AND  primary_family_id = $2
         AND  deleted_at        IS NULL`,
      [canonicalId, mergedFamilyId],
    )
    const newChildIds = newChildRows.map(r => r.child_id)

    const { rows: newSpouseRows } = await client.query<{ spouse_id: string }>(
      `SELECT CASE
         WHEN from_person_id = $1 THEN to_person_id
         ELSE from_person_id
       END AS spouse_id
       FROM relationships
       WHERE (from_person_id = $1 OR to_person_id = $1)
         AND rel_type          = 'SPOUSE_OF'
         AND primary_family_id = $2
         AND deleted_at        IS NULL`,
      [canonicalId, mergedFamilyId],
    )
    const newSpouseIds = newSpouseRows.map(r => r.spouse_id)

    const { rows: newSiblingRows } = await client.query<{ sibling_id: string }>(
      `SELECT CASE
         WHEN from_person_id = $1 THEN to_person_id
         ELSE from_person_id
       END AS sibling_id
       FROM   relationships
       WHERE  (from_person_id = $1 OR to_person_id = $1)
         AND  rel_type          = 'SIBLING_OF'
         AND  primary_family_id = $2
         AND  deleted_at        IS NULL`,
      [canonicalId, mergedFamilyId],
    )
    const newSiblingIds = newSiblingRows.map(r => r.sibling_id)

    const { rows: newParentRows } = await client.query<{ parent_id: string }>(
      `SELECT from_person_id AS parent_id
       FROM   relationships
       WHERE  to_person_id      = $1
         AND  rel_type          = 'PARENT_OF'
         AND  primary_family_id = $2
         AND  deleted_at        IS NULL`,
      [canonicalId, mergedFamilyId],
    )
    const newParentIds = newParentRows.map(r => r.parent_id)

    // Capture all persons in the merged family excluding:
    //   • the canonical node itself (stays in its own family)
    //   • the merged/deleted node (Daksh_B) — it gets soft-deleted in step 5
    //     and is not a "transferred" person; including it would make Check C
    //     wrongly classify it as a new parent of canonical.
    const { rows: newPersonRows } = await client.query<{ id: string }>(
      `SELECT id FROM persons
       WHERE primary_family_id = $1
         AND deleted_at        IS NULL
         AND id                != $2
         AND id                != $3`,
      [mergedFamilyId, canonicalId, deletedId],
    )
    const newPersonIds = newPersonRows.map(r => r.id)

    // Step 5: Soft-delete the duplicate node — capture claimed_by before deletion
    const { rows: [deletedPersonInfo] } = await client.query<{ claimed_by: string | null }>(
      `UPDATE persons SET deleted_at = NOW() WHERE id = $1 RETURNING claimed_by`,
      [deletedId],
    )
    const claimant = deletedPersonInfo?.claimed_by ?? null
    let orphanedUserId: string | null = null

    // Step 5b: If the deleted node was claimed (e.g. a new user whose self-node
    // was merged into an existing proxy), transfer ownership to the canonical node.
    //
    // Three guarantees after this block:
    //  • canonical.claimed_by = claimant (if canonical was unclaimed)
    //  • claimant is a member of canonFamilyId
    //  • claimant is NO LONGER a member of mergedFamilyId  ← fixes stale JWT
    //  • users.person_id points to canonical node
    if (claimant) {
      // Transfer claim only when canonical is still unclaimed.
      // If rowCount is 0, canonical was already claimed by someone else → orphan.
      const { rowCount } = await client.query(
        `UPDATE persons
         SET claimed_by = $1, node_state = 'claimed', updated_at = NOW()
         WHERE id = $2 AND (claimed_by IS NULL OR node_state IN ('proxy', 'invited'))`,
        [claimant, canonicalId],
      )
      if ((rowCount ?? 0) === 0) orphanedUserId = claimant
      // Join the canonical family
      await client.query(
        `INSERT INTO family_members (family_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [canonFamilyId, claimant],
      )
      // Leave the now-empty merged family so the next JWT issued picks the right one.
      // Skip in same-family merges — both ids point at the user's only family.
      if (canonFamilyId !== mergedFamilyId) {
        await client.query(
          `DELETE FROM family_members WHERE family_id = $1 AND user_id = $2`,
          [mergedFamilyId, claimant],
        )
      }
      // Point user record at the surviving node
      await client.query(
        `UPDATE users SET person_id = $1 WHERE id = $2`,
        [canonicalId, claimant],
      )
    }

    // Steps 5c–5e + family teardown only make sense for cross-family merges.
    // In a same-family merge (canonFamilyId === mergedFamilyId) the persons,
    // relationships, and members are already in the right place; tearing the
    // family down would soft-delete the user's only family and lock them out.
    if (canonFamilyId !== mergedFamilyId) {
      // Step 5c: Transfer all surviving persons from the merged family into the
      // canonical family. After the merge, Devichand (and any other nodes that
      // were in the merged family but are NOT the deleted node) must appear in
      // the canonical family's graph. The merged person itself is already
      // soft-deleted (deleted_at IS NOT NULL) so it is excluded automatically.
      await client.query(
        `UPDATE persons
         SET primary_family_id = $1, updated_at = NOW()
         WHERE primary_family_id = $2
           AND deleted_at IS NULL`,
        [canonFamilyId, mergedFamilyId],
      )

      // Step 5d: Transfer all relationships from the merged family into the
      // canonical family. The graph service queries relationships by
      // primary_family_id, so without this step the redirected edges
      // (e.g. Devichand → canonical Mahendra) remain invisible to Family B.
      await client.query(
        `UPDATE relationships
         SET primary_family_id = $1
         WHERE primary_family_id = $2
           AND deleted_at IS NULL`,
        [canonFamilyId, mergedFamilyId],
      )

      // Step 5e: Add every member of the merged family to the canonical family
      // (skip users already there). This covers invited/joined members of the
      // merged family who should now be part of the canonical family.
      await client.query(
        `INSERT INTO family_members (family_id, user_id, role)
         SELECT $1, user_id, 'member'
         FROM   family_members
         WHERE  family_id = $2
         ON CONFLICT DO NOTHING`,
        [canonFamilyId, mergedFamilyId],
      )

      // Remove all members from the merged family so future JWT refreshes and
      // logins no longer route users to this now-empty family.
      await client.query(
        `DELETE FROM family_members WHERE family_id = $1`,
        [mergedFamilyId],
      )

      // Soft-delete the merged family itself so it is excluded from all queries
      // that filter by deleted_at IS NULL (graph fetch, family lookups, etc.).
      await client.query(
        `UPDATE families SET deleted_at = NOW() WHERE id = $1`,
        [mergedFamilyId],
      )
    }

    // Step 5f: Infer cascade relationships that must exist after the merge but don't.
    //
    // After the redirect in Step 3, the canonical node has all the relationships
    // of the merged node too.  But purely redirecting edges is not enough — the
    // merged family's members are now in the canonical family and new implicit
    // relationships emerge that the system must create explicitly.
    //
    // Example (user's reported case):
    //   Family A: Mahendra ←spouse→ Joshana, Mahendra → Dipkul
    //   Family B: Mahendra_B → Yash  (Yash added Mahendra as his father)
    //   After merge canonical Mahendra has both Yash and Dipkul as children,
    //   but Joshana→Yash (Case 1) and Yash↔Dipkul (Case 2) are still missing.

    // Helper — safe insert that skips if an equivalent active edge already exists.
    // For PARENT_OF: also skips if the child already has 2+ parents to prevent
    // biologically impossible triple-parent situations from cascade inference.
    const safeInsertRel = async (
      from: string, to: string, relType: string,
    ) => {
      await client.query(
        `INSERT INTO relationships (from_person_id, to_person_id, rel_type, primary_family_id, created_by)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (
           SELECT 1 FROM relationships
           WHERE  (   (from_person_id = $1 AND to_person_id = $2)
                   OR (from_person_id = $2 AND to_person_id = $1 AND $3 = 'SIBLING_OF'))
             AND  rel_type   = $3
             AND  deleted_at IS NULL
         )
         AND ($3 != 'PARENT_OF' OR (
           SELECT COUNT(*) FROM relationships
           WHERE  to_person_id      = $2
             AND  rel_type          = 'PARENT_OF'
             AND  primary_family_id = $4
             AND  deleted_at        IS NULL
         ) < 2)`,
        [from, to, relType, canonFamilyId, acceptedBy],
      )
    }

    if (newChildIds.length > 0 || newSpouseIds.length > 0 || newSiblingIds.length > 0 || newParentIds.length > 0) {
      // After step 5d all relationships are in canonFamilyId; use the pre-captured
      // lists (newChildIds, newSpouseIds, newSiblingIds) to split "old" from "new".

      // Existing children = all current children of canonical MINUS the new ones
      const { rows: existingChildRows } = await client.query<{ child_id: string }>(
        `SELECT to_person_id AS child_id
         FROM   relationships
         WHERE  from_person_id    = $1
           AND  rel_type          = 'PARENT_OF'
           AND  primary_family_id = $2
           AND  deleted_at        IS NULL
           ${newChildIds.length > 0 ? 'AND to_person_id != ALL($3::uuid[])' : ''}`,
        newChildIds.length > 0
          ? [canonicalId, canonFamilyId, newChildIds]
          : [canonicalId, canonFamilyId],
      )
      const existingChildIds = existingChildRows.map(r => r.child_id)

      // Existing spouses = all current spouses of canonical MINUS the new ones
      const { rows: existingSpouseRows } = await client.query<{ spouse_id: string }>(
        `SELECT CASE
           WHEN from_person_id = $1 THEN to_person_id
           ELSE from_person_id
         END AS spouse_id
         FROM relationships
         WHERE (from_person_id = $1 OR to_person_id = $1)
           AND rel_type          = 'SPOUSE_OF'
           AND primary_family_id = $2
           AND deleted_at        IS NULL
           ${newSpouseIds.length > 0 ? 'AND CASE WHEN from_person_id = $1 THEN to_person_id ELSE from_person_id END != ALL($3::uuid[])' : ''}`,
        newSpouseIds.length > 0
          ? [canonicalId, canonFamilyId, newSpouseIds]
          : [canonicalId, canonFamilyId],
      )
      const existingSpouseIds = existingSpouseRows.map(r => r.spouse_id)

      // Case 1: New children inherit canonical's existing spouses as parents.
      // Joshana (existing spouse) → PARENT_OF → Yash (new child)
      for (const spouseId of existingSpouseIds) {
        for (const childId of newChildIds) {
          await safeInsertRel(spouseId, childId, 'PARENT_OF')
        }
      }

      // Case 2: New children become siblings of canonical's existing children.
      // Yash (new child) ↔ SIBLING_OF ↔ Dipkul (existing child)
      for (const existingChildId of existingChildIds) {
        for (const newChildId of newChildIds) {
          await safeInsertRel(existingChildId, newChildId, 'SIBLING_OF')
        }
      }

      // Case 2b: New children become siblings of each other (when multiple arrive).
      for (let i = 0; i < newChildIds.length; i++) {
        for (let j = i + 1; j < newChildIds.length; j++) {
          await safeInsertRel(newChildIds[i], newChildIds[j], 'SIBLING_OF')
        }
      }

      // Case 3: New spouses become parents of canonical's existing children.
      // If the merged family brought a spouse for Mahendra, that spouse is now
      // also a parent of Dipkul (existing child of canonical Mahendra).
      for (const newSpouseId of newSpouseIds) {
        for (const existingChildId of existingChildIds) {
          await safeInsertRel(newSpouseId, existingChildId, 'PARENT_OF')
        }
      }

      // Cases 4 / 5 / 5b  — sibling-side inference
      //
      // When the merged family adds a new sibling (e.g. Keshav added Mahendra as
      // brother → merge accepted), the canonical's existing parents and siblings
      // must be wired to the new sibling too.
      //
      //   Case 4:  new sibling + canonical's existing parents
      //            → parent PARENT_OF new sibling
      //            (Keshav should inherit Devichand as father)
      //
      //   Case 5:  new sibling + canonical's existing siblings
      //            → existing sibling SIBLING_OF new sibling
      //
      //   Case 5b: multiple new siblings from the same merged family
      //            → SIBLING_OF between each other
      if (newSiblingIds.length > 0) {
        // Existing parents of canonical — after step 5d all rels are in canonFamilyId,
        // so we must exclude newParentIds (which came from the merged family) to avoid
        // treating newly-arrived parents as pre-existing ones and wiring them to new
        // siblings that already have their own parents.
        const { rows: existingParentRows } = await client.query<{ parent_id: string }>(
          `SELECT from_person_id AS parent_id
           FROM   relationships
           WHERE  to_person_id      = $1
             AND  rel_type          = 'PARENT_OF'
             AND  primary_family_id = $2
             AND  deleted_at        IS NULL
             ${newParentIds.length > 0 ? 'AND from_person_id != ALL($3::uuid[])' : ''}`,
          newParentIds.length > 0
            ? [canonicalId, canonFamilyId, newParentIds]
            : [canonicalId, canonFamilyId],
        )
        const existingParentIds = existingParentRows.map(r => r.parent_id)

        // Case 4
        for (const parentId of existingParentIds) {
          for (const sibId of newSiblingIds) {
            await safeInsertRel(parentId, sibId, 'PARENT_OF')
          }
        }

        // Existing siblings of canonical MINUS the newly-arrived ones
        const { rows: existingSiblingRows } = await client.query<{ sibling_id: string }>(
          `SELECT CASE
             WHEN from_person_id = $1 THEN to_person_id
             ELSE from_person_id
           END AS sibling_id
           FROM   relationships
           WHERE  (from_person_id = $1 OR to_person_id = $1)
             AND  rel_type          = 'SIBLING_OF'
             AND  primary_family_id = $2
             AND  deleted_at        IS NULL
             AND  CASE WHEN from_person_id = $1 THEN to_person_id
                       ELSE from_person_id END != ALL($3::uuid[])`,
          [canonicalId, canonFamilyId, newSiblingIds],
        )
        const existingSiblingIds = existingSiblingRows.map(r => r.sibling_id)

        // Case 5
        for (const existingSibId of existingSiblingIds) {
          for (const newSibId of newSiblingIds) {
            await safeInsertRel(existingSibId, newSibId, 'SIBLING_OF')
          }
        }

        // Case 5b
        for (let i = 0; i < newSiblingIds.length; i++) {
          for (let j = i + 1; j < newSiblingIds.length; j++) {
            await safeInsertRel(newSiblingIds[i], newSiblingIds[j], 'SIBLING_OF')
          }
        }
      }

      // Case 6: New parents become parents of canonical's existing siblings.
      //
      // Example: Family B has Sita who added Mahendra as her son.  Family A has
      // Mahendra with sibling Keshav.  After merge Sita should also be Keshav's
      // parent — but the relationship is never created otherwise.
      //
      // Note: newParent → newSibling is already in Family B's relationships and
      // gets transferred in step 5d, so only existingSiblings need wiring here.
      if (newParentIds.length > 0) {
        // Existing siblings = all current siblings of canonical MINUS new ones
        const { rows: existingSibForParentRows } = await client.query<{ sibling_id: string }>(
          `SELECT CASE
             WHEN from_person_id = $1 THEN to_person_id
             ELSE from_person_id
           END AS sibling_id
           FROM   relationships
           WHERE  (from_person_id = $1 OR to_person_id = $1)
             AND  rel_type          = 'SIBLING_OF'
             AND  primary_family_id = $2
             AND  deleted_at        IS NULL
             ${newSiblingIds.length > 0
               ? 'AND CASE WHEN from_person_id = $1 THEN to_person_id ELSE from_person_id END != ALL($3::uuid[])'
               : ''}`,
          newSiblingIds.length > 0
            ? [canonicalId, canonFamilyId, newSiblingIds]
            : [canonicalId, canonFamilyId],
        )
        const existingSibForParentIds = existingSibForParentRows.map(r => r.sibling_id)

        for (const newParentId of newParentIds) {
          for (const sibId of existingSibForParentIds) {
            await safeInsertRel(newParentId, sibId, 'PARENT_OF')
          }
        }
      }
    }

    // Safety net: ensure every user who had a membership in either pre-merge
    // family still has at least one active family membership. Catches the
    // acceptor/claimant edge case and also covers other members that the
    // family-teardown steps could strand during a future regression.
    const usersToCheck = Array.from(new Set([
      acceptedBy,
      ...(claimant ? [claimant] : []),
      ...preMergeUserIds,
    ]))
    for (const uid of usersToCheck) {
      const { rows: memberships } = await client.query(
        `SELECT 1 FROM family_members fm
         JOIN families f ON f.id = fm.family_id AND f.deleted_at IS NULL
         WHERE fm.user_id = $1
         LIMIT 1`,
        [uid],
      )
      if (memberships.length === 0) {
        await client.query(
          `INSERT INTO family_members (family_id, user_id, role)
           VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
          [canonFamilyId, uid],
        )
        logger.warn({ uid, canonFamilyId }, 'merge safety net: restored missing family membership')
      }
    }

    // Step 6: Update merge_records
    await client.query(
      `UPDATE merge_records
       SET status       = 'confirmed',
           confirmed_by = $1,
           merged_at    = NOW()
       WHERE id = $2`,
      [acceptedBy, mergeRecordId],
    )

    // Step 7: Audit log
    await client.query(
      `INSERT INTO audit_log
         (family_id, actor_id, action, entity_type, entity_id, after_state)
       VALUES ($1, $2, 'merge.confirmed', 'person', $3, $4)`,
      [
        canonFamilyId,
        acceptedBy,
        canonicalId,
        JSON.stringify({ merge_record_id: mergeRecordId, deleted_person_id: deletedId }),
      ],
    )

    await client.query('COMMIT')

    // ── Post-commit side-effects (non-transactional) ─────────────────────────

    // Step 8: Notify initiator
    await createNotification(
      initiatedBy,
      'merge_request_accepted',
      `Your merge request for "${canonPerson.full_name}" was accepted. Your family trees are now connected.`,
      mergeRecordId,
    )

    // Step 9: Recompute family head for both families
    await recomputeFamilyHead(canonFamilyId)
    if (mergedFamilyId && mergedFamilyId !== canonFamilyId) {
      await recomputeFamilyHead(mergedFamilyId)
    }

    // Notify both families about potential name change
    await notifyFamily(
      canonFamilyId,
      'family_name_changed',
      `Your family tree has been updated after a merge with another family.`,
      mergeRecordId,
      [acceptedBy],
    )

    // Step 10: Detect conflicts introduced by the merge (non-blocking — runs
    // after commit so a detection failure never rolls back the merge itself).
    const conflictCtx: ConflictContext = {
      canonFamilyId: canonFamilyId,
      canonicalId:   canonicalId,
      newPersonIds:  newPersonIds,
      newChildIds:   newChildIds,
      newSpouseIds:  newSpouseIds,
      orphanedUserId: orphanedUserId,
    }
    const conflicts = await detectMergeConflicts(conflictCtx).catch(err => {
      logger.error({ err }, 'conflict detection failed (non-fatal)')
      return [] as MergeConflict[]
    })

    logger.info({ mergeRecordId, canonicalId, canonFamilyId, mergedFamilyId, acceptedBy, conflicts: conflicts.length }, 'merge accepted')
    return { canonical_person_id: canonicalId, conflicts }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ── Operation 4 ───────────────────────────────────────────────────────────────

// ── Operation 1c — Get merge request details ──────────────────────────────────

export interface MergeDetails {
  id:                    string
  status:                'proposed' | 'confirmed' | 'rejected' | 'reversed'
  canonical_person_id:   string
  canonical_person_name: string
  canonical_family_id:   string
  canonical_family_name: string
  merged_person_id:      string
  merged_person_name:    string
  merged_family_id:      string
  merged_family_name:    string
  created_at:            string
}

export async function getMergeById(mergeId: string): Promise<MergeDetails> {
  const { rows: [record] } = await query<MergeDetails>(
    `SELECT
       mr.id, mr.status, mr.created_at,
       cp.id           AS canonical_person_id,
       cp.full_name    AS canonical_person_name,
       cp.primary_family_id AS canonical_family_id,
       cf.name         AS canonical_family_name,
       mp.id           AS merged_person_id,
       mp.full_name    AS merged_person_name,
       mp.primary_family_id AS merged_family_id,
       mf.name         AS merged_family_name
     FROM  merge_records mr
     JOIN  persons  cp ON cp.id = mr.canonical_person_id
     JOIN  families cf ON cf.id = cp.primary_family_id
     JOIN  persons  mp ON mp.id = mr.merged_person_id
     JOIN  families mf ON mf.id = mp.primary_family_id
     WHERE mr.id = $1`,
    [mergeId],
  )
  if (!record) throw { status: 404, message: 'Merge request not found' }
  return record
}

// ── Operation 4 ───────────────────────────────────────────────────────────────

export async function rejectMerge(
  mergeRecordId: string,
  rejectedBy:    string,
): Promise<void> {
  // Fetch record first so we can check membership before mutating
  const { rows: [record] } = await query<{
    initiated_by: string; merged_person_id: string; canonical_person_id: string
  }>(
    `SELECT initiated_by, merged_person_id, canonical_person_id
     FROM merge_records WHERE id = $1 AND status = 'proposed'`,
    [mergeRecordId],
  )
  if (!record) throw { status: 404, message: 'Merge request not found or already resolved' }

  // If the canonical node is claimed, only the claimant can reject.
  // Otherwise any member of the canonical family can reject.
  const { rows: [canonPerson] } = await query<{ primary_family_id: string }>(
    `SELECT primary_family_id FROM persons WHERE id = $1`,
    [record.canonical_person_id],
  )
  const { rows: [canonClaimant] } = await query<{ id: string }>(
    `SELECT id FROM users WHERE person_id = $1 LIMIT 1`,
    [record.canonical_person_id],
  )
  if (canonClaimant) {
    if (canonClaimant.id !== rejectedBy) {
      throw { status: 403, message: 'Only the claimed owner of this node can reject this merge' }
    }
  } else {
    const { rows: [membership] } = await query(
      `SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2`,
      [canonPerson.primary_family_id, rejectedBy],
    )
    if (!membership) throw { status: 403, message: 'You are not a member of the target family' }
  }

  const { rowCount } = await query(
    `UPDATE merge_records SET status = 'rejected'
     WHERE id = $1 AND status = 'proposed'`,
    [mergeRecordId],
  )
  if (!rowCount) {
    logger.warn({ mergeRecordId, rejectedBy }, 'rejectMerge: already resolved')
    throw { status: 409, message: 'Merge request was already resolved' }
  }

  // Fetch person name for notification
  const { rows: [person] } = await query<{ full_name: string }>(
    `SELECT full_name FROM persons WHERE id = $1`,
    [record.merged_person_id],
  )

  await createNotification(
    record.initiated_by,
    'merge_request_rejected',
    `Your merge request for "${person?.full_name ?? 'Unknown'}" was declined.`,
    mergeRecordId,
  )
  logger.info({ mergeRecordId, rejectedBy }, 'merge rejected')
}
