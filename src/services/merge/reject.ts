// Operation 4 — reject a merge request. No graph mutations; just flips the
// record to 'rejected' and notifies the initiator.

import { query } from '../../utils/db'
import { createNotification } from '../notification.service'
import { logger } from '../../utils/logger'
import { forbidden, notFound, conflict } from '../../utils/errors'

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
  if (!record) throw notFound('Merge request not found or already resolved')

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
      throw forbidden('Only the claimed owner of this node can reject this merge')
    }
  } else {
    const { rows: [membership] } = await query(
      `SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2`,
      [canonPerson.primary_family_id, rejectedBy],
    )
    if (!membership) throw forbidden('You are not a member of the target family')
  }

  const { rowCount } = await query(
    `UPDATE merge_records SET status = 'rejected'
     WHERE id = $1 AND status = 'proposed'`,
    [mergeRecordId],
  )
  if (!rowCount) {
    logger.warn({ mergeRecordId, rejectedBy }, 'rejectMerge: already resolved')
    throw conflict('Merge request was already resolved')
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
