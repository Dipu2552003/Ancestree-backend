/**
 * MERGE MODULE — public surface
 *
 * search.ts    Operation 1   searchDuplicates — scored duplicate search across families
 * requests.ts  Operation 1b  listSentMergeRequests
 *              Operation 1c  getMergeById
 *              Operation 2   createMergeRequest — merge_records row + notify target family
 * accept.ts    Operation 3   acceptMerge — atomic transaction: redirect rels, soft-delete dup, notify
 * cascade.ts   (internal)    inferCascadeRelationships — step 5f of acceptMerge
 * reject.ts    Operation 4   rejectMerge — mark rejected + notify initiator
 *
 * Operation 5 (recomputeFamilyHead) lives in ../familyHead.service.ts and is
 * called internally by acceptMerge.
 */

export * from './types'
export { searchDuplicates } from './search'
export { listSentMergeRequests, getMergeById, createMergeRequest } from './requests'
export { acceptMerge } from './accept'
export { rejectMerge } from './reject'
