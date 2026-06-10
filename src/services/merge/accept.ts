// Operation 3 — accept a merge request.
//
// The whole mutation runs inside one withTransaction() envelope; post-commit
// side-effects (notifications, family-head recompute, conflict detection) run
// after COMMIT so a failure there never rolls back the merge itself.

import { withTransaction } from '../../utils/transaction'
import { createNotification, notifyFamily } from '../notification.service'
import { recomputeFamilyHead } from '../familyHead.service'
import { detectMergeConflicts, type MergeConflict, type ConflictContext } from '../mergeConflicts.service'
import { logger } from '../../utils/logger'
import { forbidden, notFound } from '../../utils/errors'
import { inferCascadeRelationships } from './cascade'

/**
 * Accept a merge request. Runs as a single database transaction.
 * The canonical node survives; the merged (newly-created) node is soft-deleted.
 */
export async function acceptMerge(
  mergeRecordId: string,
  acceptedBy:    string,
): Promise<{ canonical_person_id: string; conflicts: MergeConflict[] }> {
  logger.info({ mergeRecordId, acceptedBy }, 'merge accept: start')

  const txResult = await withTransaction(async tx => {
    // Step 1: Validate — record must exist and be proposed
    const { rows: [record] } = await tx.query<{
      id: string; canonical_person_id: string; merged_person_id: string; initiated_by: string
    }>(
      `SELECT id, canonical_person_id, merged_person_id, initiated_by
       FROM merge_records WHERE id = $1 AND status = 'proposed'`,
      [mergeRecordId],
    )
    if (!record) throw notFound('Merge request not found or already resolved')

    const canonicalId  = record.canonical_person_id
    const deletedId    = record.merged_person_id
    const initiatedBy  = record.initiated_by

    // Step 2: Verify acceptor is member of canonical family
    const { rows: [canonPerson] } = await tx.query<{
      id: string; full_name: string; primary_family_id: string
    }>(
      `SELECT id, full_name, primary_family_id FROM persons WHERE id = $1`,
      [canonicalId],
    )
    const { rows: [mergedPerson] } = await tx.query<{
      id: string; full_name: string; primary_family_id: string
    }>(
      `SELECT id, full_name, primary_family_id FROM persons WHERE id = $1`,
      [deletedId],
    )

    const canonFamilyId  = canonPerson.primary_family_id
    const mergedFamilyId = mergedPerson.primary_family_id

    // If the canonical node is claimed, only the claimant can accept.
    // Otherwise any member of the canonical family can accept.
    const { rows: [canonClaimant] } = await tx.query<{ id: string }>(
      `SELECT id FROM users WHERE person_id = $1 LIMIT 1`,
      [canonicalId],
    )
    if (canonClaimant) {
      if (canonClaimant.id !== acceptedBy) {
        throw forbidden('Only the claimed owner of this node can accept this merge')
      }
    } else {
      const { rows: [membership] } = await tx.query(
        `SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2`,
        [canonFamilyId, acceptedBy],
      )
      if (!membership) throw forbidden('You are not a member of the target family')
    }

    // Capture every user who was a member of either family BEFORE mutations.
    // The safety net at the end of the transaction restores any that lost
    // their last active membership (defence-in-depth for any future regression
    // in the family-teardown steps).
    const { rows: preMergeMembers } = await tx.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM family_members WHERE family_id = ANY($1::uuid[])`,
      [[canonFamilyId, mergedFamilyId]],
    )
    const preMergeUserIds = preMergeMembers.map(r => r.user_id)

    // Step 3: Redirect all relationships from deleted node → canonical node
    await tx.query(
      `UPDATE relationships SET from_person_id = $1
       WHERE  from_person_id = $2 AND deleted_at IS NULL`,
      [canonicalId, deletedId],
    )
    await tx.query(
      `UPDATE relationships SET to_person_id = $1
       WHERE  to_person_id = $2 AND deleted_at IS NULL`,
      [canonicalId, deletedId],
    )

    // Step 4: Remove exact duplicates created by the redirect
    await tx.query(
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
    //    to canonFamilyId, after which old vs new are indistinguishable).
    //    "New" = came from the merged family; consumed by inferCascadeRelationships
    //    (see cascade.ts for the case-by-case breakdown).

    const { rows: newChildRows } = await tx.query<{ child_id: string }>(
      `SELECT to_person_id AS child_id
       FROM   relationships
       WHERE  from_person_id    = $1
         AND  rel_type          = 'PARENT_OF'
         AND  primary_family_id = $2
         AND  deleted_at        IS NULL`,
      [canonicalId, mergedFamilyId],
    )
    const newChildIds = newChildRows.map(r => r.child_id)

    const { rows: newSpouseRows } = await tx.query<{ spouse_id: string }>(
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

    const { rows: newSiblingRows } = await tx.query<{ sibling_id: string }>(
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

    const { rows: newParentRows } = await tx.query<{ parent_id: string }>(
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
    const { rows: newPersonRows } = await tx.query<{ id: string }>(
      `SELECT id FROM persons
       WHERE primary_family_id = $1
         AND deleted_at        IS NULL
         AND id                != $2
         AND id                != $3`,
      [mergedFamilyId, canonicalId, deletedId],
    )
    const newPersonIds = newPersonRows.map(r => r.id)

    // Step 5: Soft-delete the duplicate node — capture claimed_by before deletion
    const { rows: [deletedPersonInfo] } = await tx.query<{ claimed_by: string | null }>(
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
      const { rowCount } = await tx.query(
        `UPDATE persons
         SET claimed_by = $1, node_state = 'claimed', updated_at = NOW()
         WHERE id = $2 AND (claimed_by IS NULL OR node_state IN ('proxy', 'invited'))`,
        [claimant, canonicalId],
      )
      if ((rowCount ?? 0) === 0) orphanedUserId = claimant
      // Join the canonical family
      await tx.query(
        `INSERT INTO family_members (family_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [canonFamilyId, claimant],
      )
      // Leave the now-empty merged family so the next JWT issued picks the right one.
      // Skip in same-family merges — both ids point at the user's only family.
      if (canonFamilyId !== mergedFamilyId) {
        await tx.query(
          `DELETE FROM family_members WHERE family_id = $1 AND user_id = $2`,
          [mergedFamilyId, claimant],
        )
      }
      // Point user record at the surviving node
      await tx.query(
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
      await tx.query(
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
      await tx.query(
        `UPDATE relationships
         SET primary_family_id = $1
         WHERE primary_family_id = $2
           AND deleted_at IS NULL`,
        [canonFamilyId, mergedFamilyId],
      )

      // Step 5e: Add every member of the merged family to the canonical family
      // (skip users already there). This covers invited/joined members of the
      // merged family who should now be part of the canonical family.
      await tx.query(
        `INSERT INTO family_members (family_id, user_id, role)
         SELECT $1, user_id, 'member'
         FROM   family_members
         WHERE  family_id = $2
         ON CONFLICT DO NOTHING`,
        [canonFamilyId, mergedFamilyId],
      )

      // Remove all members from the merged family so future JWT refreshes and
      // logins no longer route users to this now-empty family.
      await tx.query(
        `DELETE FROM family_members WHERE family_id = $1`,
        [mergedFamilyId],
      )

      // Soft-delete the merged family itself so it is excluded from all queries
      // that filter by deleted_at IS NULL (graph fetch, family lookups, etc.).
      await tx.query(
        `UPDATE families SET deleted_at = NOW() WHERE id = $1`,
        [mergedFamilyId],
      )
    }

    // Step 5f: Infer cascade relationships that must exist after the merge but
    // don't — runs after the family transfer so every edge it inspects/creates
    // lives in canonFamilyId. See cascade.ts.
    await inferCascadeRelationships(tx, {
      canonicalId, canonFamilyId, acceptedBy,
      newChildIds, newSpouseIds, newSiblingIds, newParentIds,
    })

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
      const { rows: memberships } = await tx.query(
        `SELECT 1 FROM family_members fm
         JOIN families f ON f.id = fm.family_id AND f.deleted_at IS NULL
         WHERE fm.user_id = $1
         LIMIT 1`,
        [uid],
      )
      if (memberships.length === 0) {
        await tx.query(
          `INSERT INTO family_members (family_id, user_id, role)
           VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
          [canonFamilyId, uid],
        )
        logger.warn({ uid, canonFamilyId }, 'merge safety net: restored missing family membership')
      }
    }

    // Step 6: Update merge_records
    await tx.query(
      `UPDATE merge_records
       SET status       = 'confirmed',
           confirmed_by = $1,
           merged_at    = NOW()
       WHERE id = $2`,
      [acceptedBy, mergeRecordId],
    )

    // Step 7: Audit log
    await tx.query(
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

    return {
      canonicalId, canonFamilyId, mergedFamilyId,
      initiatedBy, canonPersonName: canonPerson.full_name,
      newPersonIds, newChildIds, newSpouseIds, orphanedUserId,
    }
  })

  // ── Post-commit side-effects (non-transactional) ───────────────────────────

  // Step 8: Notify initiator
  await createNotification(
    txResult.initiatedBy,
    'merge_request_accepted',
    `Your merge request for "${txResult.canonPersonName}" was accepted. Your family trees are now connected.`,
    mergeRecordId,
  )

  // Step 9: Recompute family head for both families
  await recomputeFamilyHead(txResult.canonFamilyId)
  if (txResult.mergedFamilyId && txResult.mergedFamilyId !== txResult.canonFamilyId) {
    await recomputeFamilyHead(txResult.mergedFamilyId)
  }

  // Notify both families about potential name change
  await notifyFamily(
    txResult.canonFamilyId,
    'family_name_changed',
    `Your family tree has been updated after a merge with another family.`,
    mergeRecordId,
    [acceptedBy],
  )

  // Step 10: Detect conflicts introduced by the merge (non-blocking — runs
  // after commit so a detection failure never rolls back the merge itself).
  const conflictCtx: ConflictContext = {
    canonFamilyId:  txResult.canonFamilyId,
    canonicalId:    txResult.canonicalId,
    newPersonIds:   txResult.newPersonIds,
    newChildIds:    txResult.newChildIds,
    newSpouseIds:   txResult.newSpouseIds,
    orphanedUserId: txResult.orphanedUserId,
  }
  const conflicts = await detectMergeConflicts(conflictCtx).catch(err => {
    logger.error({ err }, 'conflict detection failed (non-fatal)')
    return [] as MergeConflict[]
  })

  logger.info({
    mergeRecordId, canonicalId: txResult.canonicalId,
    canonFamilyId: txResult.canonFamilyId, mergedFamilyId: txResult.mergedFamilyId,
    acceptedBy, conflicts: conflicts.length,
  }, 'merge accepted')
  return { canonical_person_id: txResult.canonicalId, conflicts }
}
