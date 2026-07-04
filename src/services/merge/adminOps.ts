// Community-owner merge operations.
//
// The community OWNER (communities.owner_id — not community 'admin's) has full
// authority over merges between any trees in their community:
//   listCommunityMerges — every merge_records row touching the community
//   forceMerge          — create + immediately accept a merge between any two
//                         community persons, no second-party approval needed.
//
// The per-request permission bypass (owner accepting/rejecting a merge they'd
// normally be blocked from) lives in accept.ts / reject.ts.

import { query } from '../../utils/db'
import { withOperation, auditCreate, type Snapshot } from '../../utils/audit'
import { logger } from '../../utils/logger'
import { forbidden, notFound, badRequest } from '../../utils/errors'
import { acceptMerge, type KeepData } from './accept'
import type { MergeConflict } from '../mergeConflicts.service'

export interface CommunityMergeRow {
  id:                    string
  status:                'proposed' | 'confirmed' | 'rejected' | 'reversed'
  created_at:            string
  merged_at:             string | null
  canonical_person_id:   string
  canonical_person_name: string
  canonical_family_id:   string
  canonical_family_name: string
  merged_person_id:      string
  merged_person_name:    string
  merged_family_id:      string
  merged_family_name:    string
  initiated_by_name:     string
}

/** Resolve the community by slug and assert the requester is its owner. */
async function ownerCommunity(slug: string, userId: string): Promise<{ id: string }> {
  const { rows: [c] } = await query<{ id: string; owner_id: string }>(
    `SELECT id, owner_id FROM communities WHERE slug = $1`,
    [slug],
  )
  if (!c) throw notFound('Community not found')
  if (c.owner_id !== userId) {
    throw forbidden('Only the community owner can manage community merges')
  }
  return c
}

/** All merge requests where either side belongs to the community. */
export async function listCommunityMerges(
  slug: string,
  userId: string,
  status?: string,
): Promise<CommunityMergeRow[]> {
  const community = await ownerCommunity(slug, userId)

  const params: unknown[] = [community.id]
  let statusSql = ''
  if (status && status !== 'all') {
    params.push(status)
    statusSql = 'AND mr.status = $2'
  }

  const { rows } = await query<CommunityMergeRow>(
    `SELECT
       mr.id, mr.status, mr.created_at, mr.merged_at,
       cp.id         AS canonical_person_id,
       cp.full_name  AS canonical_person_name,
       cf.id         AS canonical_family_id,
       cf.name       AS canonical_family_name,
       mp.id         AS merged_person_id,
       mp.full_name  AS merged_person_name,
       mf.id         AS merged_family_id,
       mf.name       AS merged_family_name,
       u.display_name AS initiated_by_name
     FROM   merge_records mr
     JOIN   persons  cp ON cp.id = mr.canonical_person_id
     JOIN   families cf ON cf.id = cp.primary_family_id
     JOIN   persons  mp ON mp.id = mr.merged_person_id
     JOIN   families mf ON mf.id = mp.primary_family_id
     JOIN   users    u  ON u.id  = mr.initiated_by
     WHERE  (cf.community_id = $1 OR mf.community_id = $1)
     ${statusSql}
     ORDER  BY mr.created_at DESC
     LIMIT  100`,
    params,
  )
  return rows
}

/**
 * Owner force-merge: canonical survives, merged is folded in — in one step.
 * Reuses a pending merge_records row for the same pair if one exists,
 * otherwise creates one, then accepts it as the owner (accept.ts recognises
 * the owner and bypasses the family-membership/claimant gate).
 */
export async function forceMerge(
  slug:              string,
  userId:            string,
  mergedPersonId:    string,
  canonicalPersonId: string,
  keepData:          KeepData = 'canonical',
): Promise<{ merge_record_id: string; canonical_person_id: string; conflicts: MergeConflict[] }> {
  const community = await ownerCommunity(slug, userId)

  if (!mergedPersonId || !canonicalPersonId) {
    throw badRequest('merged_person_id and canonical_person_id are required')
  }
  if (mergedPersonId === canonicalPersonId) {
    throw badRequest('Pick two different people to merge')
  }

  // Both must be live persons inside this community.
  const { rows: persons } = await query<{ id: string; community_id: string | null }>(
    `SELECT p.id, f.community_id
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id
     WHERE  p.id = ANY($1::uuid[]) AND p.deleted_at IS NULL AND f.deleted_at IS NULL`,
    [[mergedPersonId, canonicalPersonId]],
  )
  if (persons.length !== 2) throw notFound('One or both people were not found')
  if (persons.some(p => p.community_id !== community.id)) {
    throw forbidden('Both people must belong to this community')
  }

  // Reuse an already-pending request for this exact pair.
  const { rows: [existing] } = await query<{ id: string }>(
    `SELECT id FROM merge_records
     WHERE  merged_person_id = $1 AND canonical_person_id = $2 AND status = 'proposed'`,
    [mergedPersonId, canonicalPersonId],
  )

  let mergeRecordId = existing?.id
  if (!mergeRecordId) {
    const record = await withOperation(
      { action: 'merge.request', actorId: userId },
      async op => {
        const { rows: [row] } = await op.tx.query<Snapshot>(
          `INSERT INTO merge_records
             (canonical_person_id, merged_person_id, initiated_by, status)
           VALUES ($1, $2, $3, 'proposed')
           RETURNING *`,
          [canonicalPersonId, mergedPersonId, userId],
        )
        await auditCreate(op, 'merge_record', row)
        return row
      },
    )
    mergeRecordId = record.id as string
  }

  const result = await acceptMerge(mergeRecordId, userId, keepData)
  logger.info(
    { mergeRecordId, mergedPersonId, canonicalPersonId, userId, slug },
    'community owner force merge',
  )
  return { merge_record_id: mergeRecordId, ...result }
}
