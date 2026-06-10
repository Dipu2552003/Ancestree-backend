import { query } from '../utils/db'
import { notFound } from '../utils/errors'

export type NotificationType =
  | 'merge_request_received'
  | 'merge_request_accepted'
  | 'merge_request_rejected'
  | 'family_name_changed'
  | 'claim_suggestion'
  | 'possible_match_found'

export interface PossibleMatchDetails {
  new_person_name:           string
  new_person_birth_year:     number | null
  new_person_native_village: string | null
  new_person_gotra:          string | null
  new_person_photo_url:      string | null
  canonical_person_id:       string
  canonical_person_name:     string
  canonical_family_id:       string
  canonical_family_name:     string
  match_score:               number
  matched_fields:            string[]
}

export interface Notification {
  id:                string
  user_id:           string
  type:              NotificationType
  merge_record_id:   string | null
  related_person_id: string | null
  message:           string
  is_read:           boolean
  created_at:        string
  merge_status:      'proposed' | 'confirmed' | 'rejected' | 'reversed' | null
  details:           PossibleMatchDetails | null
}

/** Insert a single notification row. */
export async function createNotification(
  userId:          string,
  type:            NotificationType,
  message:         string,
  mergeRecordId:   string | null = null,
  relatedPersonId: string | null = null,
  details:         Record<string, unknown> | null = null,
): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, type, merge_record_id, related_person_id, message, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, type, mergeRecordId, relatedPersonId, message, details ? JSON.stringify(details) : null],
  )
}

/**
 * Create a possible_match_found notification for one match.
 * Uses ON CONFLICT DO NOTHING so repeated saves of the same person
 * never generate duplicate notifications.
 */
export async function createPossibleMatchNotification(
  userId:      string,
  newPersonId: string,
  details:     PossibleMatchDetails,
): Promise<void> {
  const message = `Possible match: "${details.new_person_name}" may be the same person as "${details.canonical_person_name}" in the ${details.canonical_family_name} family.`
  await query(
    `INSERT INTO notifications (user_id, type, related_person_id, message, details)
     VALUES ($1, 'possible_match_found', $2, $3, $4)
     ON CONFLICT (user_id, related_person_id, (details->>'canonical_person_id'))
     WHERE type = 'possible_match_found'
     DO NOTHING`,
    [userId, newPersonId, message, JSON.stringify(details)],
  )
}

/**
 * Fan-out: create one notification row per member of a family.
 * Skips users in the excludeUserIds list (e.g. the action initiator).
 */
export async function notifyFamily(
  familyId:       string,
  type:           NotificationType,
  message:        string,
  mergeRecordId:  string | null = null,
  excludeUserIds: string[]      = [],
): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, type, merge_record_id, message)
     SELECT user_id, $1, $2, $3
     FROM family_members
     WHERE family_id = $4 ${excludeUserIds.length ? 'AND user_id != ALL($5::uuid[])' : ''}`,
    excludeUserIds.length
      ? [type, mergeRecordId, message, familyId, excludeUserIds]
      : [type, mergeRecordId, message, familyId],
  )
}

/** Return all notifications for a user, newest first, max 50. */
export async function getNotifications(userId: string): Promise<Notification[]> {
  const { rows } = await query<Notification>(
    `SELECT
       n.id, n.user_id, n.type, n.merge_record_id, n.related_person_id,
       n.message, n.is_read, n.created_at, n.details,
       mr.status AS merge_status
     FROM notifications n
     LEFT JOIN merge_records mr ON mr.id = n.merge_record_id
     WHERE n.user_id = $1
     ORDER BY n.created_at DESC
     LIMIT 50`,
    [userId],
  )
  return rows
}

/** Count unread notifications for a user. */
export async function countUnread(userId: string): Promise<number> {
  const { rows: [row] } = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
    [userId],
  )
  return parseInt(row.n, 10) || 0
}

/** Mark a single notification as read; verifies ownership. */
export async function markRead(notificationId: string, userId: string): Promise<void> {
  const { rowCount } = await query(
    `UPDATE notifications SET is_read = TRUE
     WHERE id = $1 AND user_id = $2`,
    [notificationId, userId],
  )
  if (!rowCount) throw notFound('Notification not found')
}

/** Mark all notifications for a user as read. */
export async function markAllRead(userId: string): Promise<void> {
  await query(
    `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
    [userId],
  )
}
