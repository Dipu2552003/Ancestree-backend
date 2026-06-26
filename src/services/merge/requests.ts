// Operations 1b/1c/2 — merge-request lifecycle reads + creation.
// acceptMerge / rejectMerge (the resolution paths) live in accept.ts / reject.ts.

import { query } from '../../utils/db'
import { withOperation, auditCreate, type Snapshot } from '../../utils/audit'
import { createNotification, notifyFamily } from '../notification.service'
import { logger } from '../../utils/logger'
import { forbidden, notFound } from '../../utils/errors'
import type { SentMergeRequest, MergeDetails } from './types'

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

// ── Operation 1c — Get merge request details ──────────────────────────────────

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
  if (!record) throw notFound('Merge request not found')
  return record
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
    throw forbidden('You can only request merges for persons in your own family')
  }

  // Block cross-community merges: both families must share the same community scope
  // (both public → null === null, or both in the same community → same UUID).
  const { rows: [initiatorScope] } = await query<{ community_id: string | null }>(
    `SELECT community_id FROM families WHERE id = $1`,
    [initiatorFamilyId],
  )
  const { rows: [canonScope] } = await query<{ community_id: string | null }>(
    `SELECT f.community_id FROM families f
     JOIN   persons p ON p.primary_family_id = f.id
     WHERE  p.id = $1 AND f.deleted_at IS NULL`,
    [canonicalPersonId],
  )
  if (initiatorScope && canonScope &&
      initiatorScope.community_id !== canonScope.community_id) {
    throw forbidden(
      'Merges are only allowed between families in the same community scope. ' +
      'A community family cannot merge with a public family.',
    )
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

  const record = await withOperation(
    { action: 'merge.request', actorId: initiatedBy, familyId: initiatorFamilyId },
    async op => {
      const { rows: [row] } = await op.tx.query<Snapshot>(
        `INSERT INTO merge_records
           (canonical_person_id, merged_person_id, initiated_by, status)
         VALUES ($1, $2, $3, 'proposed')
         RETURNING *`,
        [canonicalPersonId, newPersonId, initiatedBy],
      )
      await auditCreate(op, 'merge_record', row)
      return row
    },
  )
  const mergeRecordId = record.id as string

  // Fetch person names for the notification message
  const { rows: persons } = await query<{ id: string; full_name: string; primary_family_id: string }>(
    `SELECT id, full_name, primary_family_id FROM persons WHERE id = ANY($1::uuid[])`,
    [[newPersonId, canonicalPersonId]],
  )
  const canonPerson = persons.find(p => p.id === canonicalPersonId)
  const newPerson   = persons.find(p => p.id === newPersonId)
  if (!canonPerson || !newPerson) {
    throw notFound('One or more persons not found')
  }

  // Name the person who initiated the request (not their family) so the
  // recipient sees who is asking.
  const { rows: [initiator] } = await query<{ display_name: string }>(
    `SELECT display_name FROM users WHERE id = $1`,
    [initiatedBy],
  )
  const initiatorName = initiator?.display_name ?? 'Someone'

  const message =
    `${initiatorName} believes their "${newPerson.full_name}" ` +
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
