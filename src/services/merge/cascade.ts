// Step 5f of acceptMerge — infer cascade relationships that must exist after
// the merge but don't.
//
// After the relationship redirect, the canonical node has all the relationships
// of the merged node too.  But purely redirecting edges is not enough — the
// merged family's members are now in the canonical family and new implicit
// relationships emerge that the system must create explicitly:
//
//   Case 1  New children  + existing spouses  →  spouse PARENT_OF new child
//   Case 2  New children  + existing children →  SIBLING_OF between them
//   Case 2b New children  + new children      →  SIBLING_OF between them
//   Case 3  New spouses   + existing children →  new spouse PARENT_OF child
//   Case 4  New siblings  + existing parents  →  parent PARENT_OF new sibling
//   Case 5  New siblings  + existing siblings →  SIBLING_OF between them
//   Case 5b New siblings  + new siblings      →  SIBLING_OF between them
//   Case 6  New parents   + existing siblings →  new parent PARENT_OF existing sibling
//
// "New" = came from the merged family (captured before the family transfer made
// old and new indistinguishable).
//
// Example (user's reported case):
//   Family A: Mahendra ←spouse→ Joshana, Mahendra → Dipkul
//   Family B: Mahendra_B → Yash  (Yash added Mahendra as his father)
//   After merge canonical Mahendra has both Yash and Dipkul as children,
//   but Joshana→Yash (Case 1) and Yash↔Dipkul (Case 2) are still missing.

import type { QueryRunner } from '../../utils/db'

export interface CascadeContext {
  canonicalId:   string
  canonFamilyId: string
  acceptedBy:    string
  newChildIds:   string[]
  newSpouseIds:  string[]
  newSiblingIds: string[]
  newParentIds:  string[]
}

/**
 * Runs inside the acceptMerge transaction (`tx` is the tx-scoped runner).
 * Must be called AFTER all relationships have been moved into canonFamilyId.
 */
export async function inferCascadeRelationships(tx: QueryRunner, ctx: CascadeContext): Promise<void> {
  const { canonicalId, canonFamilyId, acceptedBy, newChildIds, newSpouseIds, newSiblingIds, newParentIds } = ctx

  if (newChildIds.length === 0 && newSpouseIds.length === 0 && newSiblingIds.length === 0 && newParentIds.length === 0) {
    return
  }

  // Helper — safe insert that skips if an equivalent active edge already exists.
  // For PARENT_OF: also skips if the child already has 2+ parents to prevent
  // biologically impossible triple-parent situations from cascade inference.
  const safeInsertRel = async (
    from: string, to: string, relType: string,
  ) => {
    await tx.query(
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

  // All relationships are already in canonFamilyId; use the pre-captured
  // lists (newChildIds, newSpouseIds, newSiblingIds) to split "old" from "new".

  // Existing children = all current children of canonical MINUS the new ones
  const { rows: existingChildRows } = await tx.query<{ child_id: string }>(
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
  const { rows: existingSpouseRows } = await tx.query<{ spouse_id: string }>(
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
    // Existing parents of canonical — all rels are in canonFamilyId by now,
    // so we must exclude newParentIds (which came from the merged family) to avoid
    // treating newly-arrived parents as pre-existing ones and wiring them to new
    // siblings that already have their own parents.
    const { rows: existingParentRows } = await tx.query<{ parent_id: string }>(
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
    const { rows: existingSiblingRows } = await tx.query<{ sibling_id: string }>(
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
  // gets transferred with the family, so only existingSiblings need wiring here.
  if (newParentIds.length > 0) {
    // Existing siblings = all current siblings of canonical MINUS new ones
    const { rows: existingSibForParentRows } = await tx.query<{ sibling_id: string }>(
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
