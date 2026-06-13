# Safety Net — Operation Log + Undo

> Phase 1 of the data-safety work. Every change to the family tree is recorded
> as an **operation** in the `audit_log` table, and every operation can be
> **undone** — including the undo itself. History is never deleted.
>
> Diagrams are [Mermaid](https://mermaid.js.org/) — they render on GitHub and
> in VS Code (with the Mermaid extension).

---

## 1. The big picture

Every mutation in the backend goes through the same pipeline. Nothing writes
to `persons`, `relationships`, `families`, `family_members`, or
`merge_records` without leaving a trace.

```mermaid
flowchart TD
    A["User action<br/>(delete node, merge, edit, ...)"] --> B["API route<br/>e.g. DELETE /api/persons/:id"]
    B --> C["withOperation()<br/>opens ONE database transaction<br/>creates ONE operation_id"]
    C --> D["Mutation 1<br/>e.g. soft-delete relationships"]
    C --> E["Mutation 2<br/>e.g. soft-delete person"]
    D --> F["writeAudit()<br/>1 audit row per changed DB row<br/>(before + after snapshot)"]
    E --> F
    F --> G{"Did everything<br/>succeed?"}
    G -- yes --> H["COMMIT<br/>data + logs saved together"]
    G -- no --> I["ROLLBACK<br/>zero trace — no data change,<br/>no audit rows, as if nothing happened"]
```

**Key idea:** data and logs live in the *same* transaction. You can never have
a change without its log entry, or a log entry without its change.

---

## 2. The `audit_log` table

One row = one database row that changed. One **operation_id** = one logical
user action (which may touch many rows).

| Column         | What it means                                                            |
|----------------|--------------------------------------------------------------------------|
| `operation_id` | Groups all rows of one user action. A merge = 1 operation, many rows.    |
| `seq`          | Insertion order. Undo replays rows **newest-first** (`seq DESC`).        |
| `action`       | What happened: `person.delete`, `merge.accept`, `undo`, ...              |
| `entity_type`  | Which table: `person`, `relationship`, `family`, `family_member`, ...    |
| `entity_id`    | The id of the changed row.                                               |
| `before_state` | Full JSON snapshot of the row **before** the change. `NULL` = created.   |
| `after_state`  | Full JSON snapshot of the row **after** the change. `NULL` = deleted.    |
| `actor_id`     | Which user did it (`NULL` = system, e.g. family-name recompute).         |
| `family_id`    | Which family's history this belongs to.                                  |
| `reverted_by`  | `NULL` = still in effect. Otherwise = the operation_id of the undo.      |

How undo knows what to do — just from the two snapshots:

```mermaid
flowchart LR
    A{"before / after?"} -->|"before = NULL"| B["Row was CREATED<br/>undo → DELETE it"]
    A -->|"after = NULL"| C["Row was DELETED<br/>undo → re-INSERT before_state<br/>(same id, same timestamps)"]
    A -->|"both present"| D["Row was UPDATED<br/>undo → write before_state back"]
```

---

## 3. Feature: Delete a node

**What you see:** you delete "Priya" from the tree.
**What actually happens:** her edges are *soft-deleted* (a `deleted_at`
timestamp is set — the rows stay in the database), then the node itself.

```mermaid
sequenceDiagram
    participant U as User
    participant API as DELETE /api/persons/:id
    participant OP as withOperation("person.delete")
    participant DB as PostgreSQL

    U->>API: delete Priya
    API->>OP: open transaction, operation_id = ABC
    OP->>DB: UPDATE relationships SET deleted_at = NOW()<br/>(parent edges, sibling edges, spouse edges, child edges)
    OP->>DB: audit row per edge (op ABC): before={alive edge}, after={edge with deleted_at}
    OP->>DB: UPDATE persons SET deleted_at = NOW() WHERE id = priya
    OP->>DB: audit row (op ABC): before={Priya alive}, after={Priya deleted_at set}
    OP->>DB: COMMIT
    Note over DB: persons row still exists!<br/>It is only hidden by deleted_at.<br/>That is why undo can bring it back.
```

After this, `audit_log` contains (example):

| seq | operation_id | action          | entity_type  | before                 | after                  |
|-----|--------------|-----------------|--------------|------------------------|------------------------|
| 41  | **ABC**      | `person.delete` | relationship | `{deleted_at: null}`   | `{deleted_at: now}`    |
| 42  | **ABC**      | `person.delete` | person       | `{deleted_at: null}`   | `{deleted_at: now}`    |

Two DB rows changed → two audit rows → **one** operation_id → one entry in the
History panel: *"Removed Priya from the tree · 2 changes"*.

> Special case: claimed nodes (a real user's account) and nodes that still
> have their own family unit are never node-deleted — only their connecting
> edges are removed. The audit rows reflect exactly what was touched.

---

## 4. Feature: Undo

Undo reads all audit rows of an operation **newest-first** and restores each
row's `before_state`. The undo runs inside its own `withOperation()`, so it is
logged like any other operation — and can itself be undone.

```mermaid
sequenceDiagram
    participant U as User
    participant API as POST /family/:id/history/ABC/undo
    participant OP as withOperation("undo") → operation_id = UND1
    participant DB as PostgreSQL

    U->>API: undo operation ABC
    API->>DB: SELECT * FROM audit_log WHERE operation_id = 'ABC' ORDER BY seq DESC
    Note over API: checks: belongs to your family?<br/>not already reverted?
    API->>OP: open new transaction
    loop each audit row, newest first
        OP->>DB: restore before_state<br/>(re-insert deleted / delete created / rewrite updated)
        OP->>DB: write NEW audit row under UND1<br/>(so the undo is fully logged too)
    end
    OP->>DB: UPDATE audit_log SET reverted_by = 'UND1' WHERE operation_id = 'ABC'
    OP->>DB: COMMIT
    Note over DB: Priya and her edges are back,<br/>exactly as before — same ids,<br/>same created_at timestamps.
```

### Undo the undo

History is append-only. Undoing an undo does **not** delete anything — it
creates a third operation that re-applies the original change:

```mermaid
flowchart LR
    A["ABC<br/>person.delete<br/>reverted_by: UND1"] -->|"undone by"| B["UND1<br/>undo<br/>reverted_by: UND2"]
    B -->|"undone by"| C["UND2<br/>undo of the undo<br/>(Priya deleted again)"]
    C -.->|"clears reverted_by on ABC<br/>so ABC is undoable again"| A
```

The chain in plain words:

1. **ABC** deleted Priya.
2. **UND1** undid ABC → Priya is back. ABC is stamped `reverted_by = UND1`.
3. **UND2** undid UND1 → Priya is deleted again. UND1 is stamped
   `reverted_by = UND2`, **and** ABC's `reverted_by` is cleared — because
   ABC's effect is back in force, it must be undoable again.

All three operations stay in `audit_log` forever.

---

## 5. Feature: Merge (the big one)

A merge says: *"this duplicate node in family B is the same person as the
canonical node in family A."* On accept, **family B is absorbed into family
A** — and the whole thing is **one operation**, so one undo reverses all of it.

```mermaid
sequenceDiagram
    participant U as Acceptor
    participant OP as withOperation("merge.accept")
    participant DB as PostgreSQL

    U->>OP: accept merge (canonical = Mahendra-A, duplicate = Mahendra-B)
    Note over OP: every step below writes audit rows<br/>under the SAME operation_id

    OP->>DB: 1. redirect all edges: Mahendra-B → Mahendra-A
    OP->>DB: 2. hard-DELETE exact duplicate edges created by the redirect<br/>(full snapshot saved — undo re-inserts them)
    OP->>DB: 3. soft-delete the duplicate person Mahendra-B
    OP->>DB: 4. if Mahendra-B was claimed: move the claim + user pointer to Mahendra-A
    OP->>DB: 5. move ALL persons of family B → primary_family_id = family A
    OP->>DB: 6. move ALL relationships of family B → family A
    OP->>DB: 7. copy family B members into family_members of A,<br/>then delete family B memberships
    OP->>DB: 8. soft-delete family B itself (deleted_at)
    OP->>DB: 9. infer missing edges (new children ↔ existing spouse, siblings, ...)
    OP->>DB: 10. merge_records → status = 'confirmed'
    OP->>DB: COMMIT

    Note over DB: AFTER COMMIT (separate small operation):<br/>recomputeFamilyHead → family name may change,<br/>e.g. "Mahendra Family" → "Devichand Family"
```

### What happens to `family_id` and the family name?

```mermaid
flowchart TD
    subgraph before ["BEFORE merge"]
        FA["Family A · id = aaa<br/>name: 'Mahendra Family'"]
        FB["Family B · id = bbb<br/>name: 'Yash Family'"]
        P1["Mahendra-A<br/>primary_family_id = aaa"] --- FA
        P2["Mahendra-B (duplicate)<br/>primary_family_id = bbb"] --- FB
        P3["Yash<br/>primary_family_id = bbb"] --- FB
    end

    before ==>|"merge accepted"| after

    subgraph after ["AFTER merge"]
        FA2["Family A · id = aaa<br/>name recomputed from new tree root,<br/>e.g. 'Devichand Family'"]
        FB2["Family B · id = bbb<br/>deleted_at = NOW() — soft-deleted,<br/>row still exists for undo"]
        Q1["Mahendra-A · family aaa<br/>(absorbed Mahendra-B's claim + edges)"] --- FA2
        Q2["Mahendra-B · family bbb<br/>deleted_at set"] --- FB2
        Q3["Yash · primary_family_id = aaa ← moved!"] --- FA2
    end
```

- **family_id never changes** for a surviving family — people are *moved* by
  rewriting their `primary_family_id` to point at family A.
- **Family B is never hard-deleted** — it gets `deleted_at` so logins, graph
  fetches, and searches skip it, but undo can clear that timestamp.
- **The family NAME is derived data**: after a merge (and after structural
  undos), `recomputeFamilyHead` walks `PARENT_OF` edges to the topmost
  ancestor and renames the family "*FirstName* Family". That rename is logged
  as its own tiny operation (`family.update_head`, actor = System) — and only
  when the name actually changes, so history stays clean.

### Undoing a merge

Because every step above saved a before-snapshot, undoing the merge operation
restores, newest-first: the merge_record to `proposed`, family B's
`deleted_at` to `NULL`, all memberships, every person's old
`primary_family_id`, the claim/user pointer, the hard-deleted duplicate edges
(re-inserted with their original ids), the redirected edges, and the duplicate
node. The two trees separate again.

---

## 6. Feature: History endpoint + panel

```mermaid
flowchart LR
    A["GET /api/family/:id/history"] --> B["GROUP BY operation_id<br/>newest first"]
    B --> C["per operation:<br/>• human summary ('Removed Priya...')<br/>• actor name<br/>• timestamp<br/>• change count<br/>• reverted? can_undo?"]
    C --> D["Frontend HistoryPanel<br/>(clock icon, top-right HUD)"]
    D -->|"Undo → Confirm?"| E["POST .../history/:opId/undo"]
    E --> F["graph refetches —<br/>restored nodes reappear"]
```

The summary is built from the snapshots themselves — e.g. a `person.delete`
operation finds the person row's `full_name` in its `before_state`, so the
panel can say *who* was removed without extra queries per row.

---

## 7. What every action writes (cheat sheet)

| You do this              | action            | Audit rows written                                                       |
|--------------------------|-------------------|--------------------------------------------------------------------------|
| Sign up                  | `family.create`   | family created, membership created, self person created, user→person pointer |
| Add a person             | `person.create`   | 1 person row (after only)                                                |
| Edit a person            | `person.update`   | 1 person row (before + after)                                            |
| Send an invite           | `person.invite`   | 1 person row (token + state change)                                      |
| Claim a node             | `person.claim`    | person update + membership insert                                        |
| Delete a person          | `person.delete`   | every removed edge + the node (if node-deleted)                          |
| Add a relationship       | `relationship.create` | the edge + any auto-created sibling-group edges                      |
| Delete a relationship    | `relationship.delete` | 1 edge (soft-delete as update)                                       |
| Re-mother children       | `person.reparent` | old mother edges removed + new edges created                             |
| Request / reject a merge | `merge.request` / `merge.reject` | 1 merge_record row                                        |
| Accept a merge           | `merge.accept`    | everything in section 5 — often 10–50+ rows, one operation               |
| Undo anything            | `undo`            | 1 row per restored row + a marker naming the reverted operation          |
| (automatic) name recompute | `family.update_head` | 1 family row, only when the name/head actually changed              |

**Deliberately NOT logged** (and why):

- `families.person_code_seq` bumps — a forever-increasing counter; rewinding
  it on undo would hand out duplicate person codes.
- User account data (email, password hash, reset tokens) — account stuff, not
  tree data. Only the `users.person_id` graph pointer is snapshotted.
- Notifications — derived side-effects, recreated by normal use.

---

## 8. Where the code lives

| Piece                    | File                                                  |
|--------------------------|-------------------------------------------------------|
| Table migration          | `database/migrations/015_audit_operations.sql`        |
| Writer + wrapper + helpers | `src/utils/audit.ts`                                |
| Undo + history queries   | `src/services/history.service.ts`                     |
| HTTP routes              | `src/routes/history.routes.ts` (mounted at `/api/family`) |
| End-to-end proof         | `database/verifyRecovery.ts` → `npm run verify:recovery` |
| Frontend panel           | `frontend/components/graph/HistoryPanel.tsx`          |
| Frontend API             | `frontend/lib/api/history.ts`                         |
