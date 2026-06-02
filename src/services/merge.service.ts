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

export interface PotentialMatch {
  id:             string
  full_name:      string
  birth_year:     number | null
  native_village: string | null
  family_name:    string
  family_id:      string
  member_count:   number
}

// ── Operation 1 ───────────────────────────────────────────────────────────────

/**
 * Exact-name search across all families except the caller's.
 * Called immediately after a person is created.
 */
export async function searchDuplicates(
  fullName: string,
  callerFamilyId: string,
): Promise<PotentialMatch[]> {
  const { rows } = await query<PotentialMatch>(
    `SELECT p.id,
            p.full_name,
            p.birth_year,
            p.native_village,
            f.name        AS family_name,
            f.id          AS family_id,
            (SELECT COUNT(*) FROM family_members fm WHERE fm.family_id = f.id)::int AS member_count
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id
     WHERE  p.full_name           = $1
       AND  p.deleted_at         IS NULL
       AND  p.primary_family_id  != $2
       AND  f.deleted_at         IS NULL
     LIMIT  10`,
    [fullName, callerFamilyId],
  )
  return rows
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

  // Notify all members of the canonical family (excluding initiator)
  await notifyFamily(
    canonPerson.primary_family_id,
    'merge_request_received',
    message,
    mergeRecordId,
    [initiatedBy],
  )

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

    const { rows: [membership] } = await client.query(
      `SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2`,
      [canonFamilyId, acceptedBy],
    )
    if (!membership) throw { status: 403, message: 'You are not a member of the target family' }

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
      // Leave the now-empty merged family so the next JWT issued picks the right one
      await client.query(
        `DELETE FROM family_members WHERE family_id = $1 AND user_id = $2`,
        [mergedFamilyId, claimant],
      )
      // Point user record at the surviving node
      await client.query(
        `UPDATE users SET person_id = $1 WHERE id = $2`,
        [canonicalId, claimant],
      )
    }

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
         )`,
        [from, to, relType, canonFamilyId, acceptedBy],
      )
    }

    if (newChildIds.length > 0 || newSpouseIds.length > 0) {
      // After step 5d all relationships are in canonFamilyId; use the pre-captured
      // lists (newChildIds, newSpouseIds) to split "old" from "new".

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
      console.error('Conflict detection failed (non-fatal):', err)
      return [] as MergeConflict[]
    })

    return { canonical_person_id: canonicalId, conflicts }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ── Operation 4 ───────────────────────────────────────────────────────────────

export async function rejectMerge(
  mergeRecordId: string,
  rejectedBy:    string,
): Promise<void> {
  const { rows: [record] } = await query<{ initiated_by: string; merged_person_id: string }>(
    `UPDATE merge_records SET status = 'rejected'
     WHERE id = $1 AND status = 'proposed'
     RETURNING initiated_by, merged_person_id`,
    [mergeRecordId],
  )
  if (!record) throw { status: 404, message: 'Merge request not found or already resolved' }

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
}
