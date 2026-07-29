# Core Concepts

> This section explains the fundamental building blocks of Ancestree — the data model, the rules that govern it, and the reasoning behind key design decisions. Read this before diving into any feature.

---

## Table of Contents

1. [Why a Graph, Not a Tree](#1-why-a-graph-not-a-tree)
2. [Persons](#2-persons)
3. [Families](#3-families)
4. [Node States](#4-node-states)
5. [Relationships](#5-relationships)
6. [Cascade Inference](#6-cascade-inference)
7. [Relationship Labels](#7-relationship-labels)
8. [Soft Deletes](#8-soft-deletes)
9. [Homes](#9-homes)

---

## 1. Why a Graph, Not a Tree

The word "family tree" implies a strict branching structure — one root, no loops, each person appearing exactly once. Real families do not work that way:

- A grandfather who remarried has two sets of children from different mothers.
- Cousins who marry appear in two branches simultaneously.
- A person adopted into a family still carries biological relationships.
- After a merge, two previously separate families share nodes.

Ancestree models the family as a **directed graph** where:
- **Nodes** are persons.
- **Edges** are typed relationships between any two persons.
- A person can have multiple parents, multiple spouses, multiple siblings — each as an explicit edge.

The graph is rendered on an interactive canvas using React Flow. The layout engine computes visual positions automatically so users never need to arrange nodes manually.

---

## 2. Persons

A `person` is the atomic unit of the graph. Every node on the canvas represents exactly one person record in the database.

### Identity Fields

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key, auto-generated |
| `person_code` | TEXT | Human-readable identifier, e.g. `KHA-001` |
| `full_name` | TEXT | Required. The display name used everywhere |
| `first_name` | TEXT | Optional. Used for relationship label derivation and merge scoring |
| `last_name` | TEXT | Optional. Used for merge scoring |
| `name_native` | TEXT | Name in native script (Devanagari, etc.) |
| `nickname` | TEXT | Informal name |

### Biographical Fields

| Field | Type | Notes |
|---|---|---|
| `gender` | ENUM | `male`, `female`, `other`, `unknown` |
| `gotra` | TEXT | Ancestral lineage clan — used in merge duplicate scoring |
| `religion` | TEXT | Defaults to `Hindu` |
| `birth_year` | INTEGER | Year only (not full date) for privacy |
| `birth_date` | DATE | Full date, optional |
| `birth_place` | TEXT | |
| `is_alive` | BOOLEAN | Defaults to `true` |
| `death_year` | INTEGER | Only set when `is_alive = false` |
| `death_date` | DATE | Full date, optional |
| `death_place` | TEXT | |

### Location Fields

| Field | Type | Notes |
|---|---|---|
| `current_city` | TEXT | Where the person lives now |
| `current_state` | TEXT | |
| `current_country` | TEXT | Defaults to `India` |
| `native_village` | TEXT | Village of origin — used in merge duplicate scoring |
| `native_tehsil` | TEXT | |
| `native_district` | TEXT | |
| `native_state` | TEXT | |

### Professional & Social Fields

| Field | Type | Notes |
|---|---|---|
| `occupation` | TEXT | |
| `education` | TEXT | |
| `bio` | TEXT | Free-text description, up to 2000 characters |
| `phone` | TEXT | |
| `whatsapp` | TEXT | |
| `email` | TEXT | |

### Graph / System Fields

| Field | Type | Notes |
|---|---|---|
| `primary_family_id` | UUID | Which family this person belongs to |
| `node_state` | ENUM | `proxy`, `invited`, or `claimed` — see Section 4 |
| `claimed_by` | UUID | FK to `users.id`; set when a user claims this node |
| `created_by` | UUID | FK to `users.id`; who added this person |
| `visibility` | ENUM | `private`, `family`, `public` |
| `photo_url` | TEXT | URL to profile photo |
| `invite_token` | TEXT | Short alphanumeric code used for invite claiming |
| `deleted_at` | TIMESTAMPTZ | `NULL` = active; set = soft-deleted |

### Person Codes

Every person gets a unique, human-readable `person_code` derived from their family's prefix and a sequential counter:

```
person_code = name_prefix + "-" + zero-padded sequence

Examples:
  KHA-001   (first person in the Khandelwal family)
  KHA-042   (42nd person added to that family)
  RAM-001   (first person in a different family)
```

The `name_prefix` is computed from the family creator's last name (up to 6 uppercase letters, e.g. `KHANDE` or `SHARMA`). The sequence counter lives on the `families` table and increments atomically on each insert, guaranteeing no duplicates even under concurrent requests.

Person codes are **permanent** — they do not change after a merge or family rename.

---

## 3. Families

A `family` is the organisational container that groups persons and their relationships. Every person belongs to exactly one `primary_family_id`.

### What a Family Contains

- All the persons added by its members
- All the relationships between those persons
- A computed `head_person_id` — the **cluster head**, topmost ancestor of the whole row (see below)
- A human-readable `name` — auto-updated to `"{FirstName} Family"` after changes

### Family Membership

Membership is tracked in the `family_members` join table:

| Column | Notes |
|---|---|
| `family_id` | Which family |
| `user_id` | Which user |
| `role` | `admin` (can do everything) or `member` (can add/edit, cannot delete others) |

The user who creates a family is automatically its `admin`. When someone joins via an invite, they are added as a `member`.

### Cluster vs Family Unit — two different "heads"

These two concepts are easy to confuse. They are **not** the same thing:

| Concept | Column | Cardinality | Answers |
|---|---|---|---|
| **Cluster head** | `families.head_person_id` | one per `families` row | "how many separate, disconnected trees exist?" |
| **Family head** | `persons.family_head_id` | one per lineage *inside* a cluster | "how many bloodlines run through this tree?" |

A third "head" exists — the **home head** (`homes.head_person_id`) — but it is unrelated to lineage: it is an explicitly chosen member of a hand-picked group of people who *live together* (defaulted to the eldest by generation, never by birthdate). See [Homes](#9-homes).

A **cluster** is a `families` row. Because a merge fuses two connected families into one row (the loser is soft-deleted and everyone is repointed to the survivor — see [Family Lifecycle](#family-lifecycle)), a single row can hold many bloodlines that became connected. So the cluster head is the single topmost ancestor of the *entire* row, while each bloodline within it has its own family head.

**Worked example.** "Mahendra Family" merges into "Devichand Family":
- *Same bloodline* (Devichand turns out to be Mahendra's ancestor) → one cluster, **one** lineage. `family_head_id` = Devichand for everyone; cluster head = Devichand too. Here the two heads coincide.
- *Marriage link* (a Devichand-line person married a Mahendra-line person) → one cluster, **two** lineages. Cluster head = whichever of the two is eldest; `family_head_id` stays Mahendra for one line and Devichand for the other.

### Cluster Head (`families.head_person_id`)

The topmost ancestor of the whole `families` row. Recomputed by `recomputeFamilyHead` after: person added, person deleted, merge accepted.

Algorithm:
1. Start from all persons in the family.
2. Walk `PARENT_OF` edges upward recursively (ancestors may live in other families after a merge).
3. Find all roots — persons with no parent within the ancestry set.
4. Among roots, rank by: male gender first → earliest `birth_year` → lowest `person_code` (stable tiebreak).
5. The winner becomes `head_person_id`. The family is renamed `"{HeadFirstName} Family"`.

This value is **write-only / derived** — it (and the derived `name`) exist to be recomputed; no read path drives behavior off `head_person_id` directly.

### Family Head (`persons.family_head_id`)

Every person points at the topmost ancestor of **their own patriline** — the lineage they are blood-connected to. This is what the top-left family badge shows, made perspective-correct: viewing someone in another bloodline shows *that* line's head.

**The one rule — how a lineage is bounded (structural, patrilineal):**

> Two people share a family unit iff connected by a **`PARENT_OF` edge through a *male* parent**, or by a **`SIBLING_OF` edge**. `SPOUSE_OF` (marriage) is **ignored**.

Consequences of that rule:
- A married-in wife belongs to *her own father's* lineage, never her husband's. Her children follow their **father's** line, not hers.
- A married-in woman whose birth family isn't otherwise in the tree is a lineage **of size one** (herself) — and is counted as such: it *is* her mayka. She is her own `family_head_id`.
- **Marriage never changes a family head.** Only `PARENT_OF` / `SIBLING_OF` changes (and person add/delete/merge, which move those edges) trigger a recompute — see [Recompute Triggers](#family-head-recompute-triggers).
- Ignoring marriage is what prevents a shared child from fusing both parents' entire ancestries into one blob.

Head selection within each lineage matches the cluster rule: male → earliest `birth_year` → lowest `person_code`.

Counting: `COUNT(DISTINCT family_head_id)` within a `primary_family_id` = number of lineages in that cluster. Counting non-deleted `families` rows = number of independent clusters.

Like `head_person_id`, `family_head_id` is **derived data** — recomputed, never hand-edited, and excluded from the audit trail / undo snapshots (undo recomputes it instead).

#### Family Head Recompute Triggers

`recomputeFamilyHeads(familyId)` re-derives every person's `family_head_id` in one pass. It runs after any event that can reshape a patriline:

| Trigger | Recompute? | Why |
|---|---|---|
| `PARENT_OF` added / removed | ✅ | changes who sits above whom |
| `SIBLING_OF` added / removed | ✅ | changes lineage grouping |
| Person added / deleted | ✅ | a deleted father splits children into new lineages |
| Merge accepted | ✅ | edges move between families |
| `SPOUSE_OF` added / removed | ❌ | marriage is ignored by the rule. (Spouse-add *cascades* into new `PARENT_OF` edges — those go through the `PARENT_OF` trigger, so heads still update.) |

### Family Lifecycle

A family is **soft-deleted** (`deleted_at` is set) when it is the losing side of a merge. After that:
- All its persons are transferred to the surviving family.
- All its relationships are retargeted to the surviving family.
- All its members are added to the surviving family.
- The deleted family is excluded from all future queries.

---

## 4. Node States

Every person node moves through a lifecycle with three states:

```
  proxy  ──invite sent──>  invited  ──user claims──>  claimed
```

### `proxy`

The default state. A family member added this person on behalf of someone who is not yet on the platform. The person has no associated user account.

- Can be freely edited by any family member.
- Can be deleted (unless they have a spouse or children of their own).
- Displayed with a marigold avatar on the canvas.

### `invited`

An invite token has been generated and (presumably) shared with the real person. The node is still effectively a proxy — no user account is linked yet.

- The `invite_token` field holds a short code like `A3F7`.
- The person can join by visiting the invite link and signing up or logging in.
- Still editable by family members until claimed.
- Displayed with a "Invite sent" hover badge.

### `claimed`

A real user has linked their account to this node. This person is now on the platform.

- Only the account holder can edit their own claimed node's profile fields.
- Other family members can still add/edit relationships from this node.
- The node can never be hard-deleted (the account still exists).
- Displayed with a terracotta avatar. The current user's own claimed node gets a saffron avatar and a "YOU" badge.

### Visual Summary

| State | Canvas Avatar | Hover Badge |
|---|---|---|
| `proxy` | Marigold `#D97706` | "Not on Ancestree yet" |
| `invited` | Marigold `#D97706` | "Invite sent" |
| `claimed` (other) | Terracotta `#C2410C` | "Joined · {FirstName}" |
| `claimed` (self) | Saffron `#EA580C` + YOU badge | — |
| `is_alive = false` | Slate `#94A3B8` | — |

---

## 5. Relationships

Relationships are directed edges between two persons. Three types are supported.

### PARENT_OF

```
from_person_id  ──PARENT_OF──>  to_person_id
     (parent)                      (child)
```

- **Directional**: `from` is always the parent, `to` is always the child.
- A person can have at most 2 biological parents, but the system allows more (step-parents, adoptive parents) with appropriate `sub_type`.
- Adding this edge triggers a **cycle check** — the system rejects any relationship that would make someone their own ancestor.

Sub-types: `biological` (default), `adopted`, `step`

### SPOUSE_OF

```
from_person_id  ──SPOUSE_OF──  to_person_id
```

- **Bidirectional** by convention — the edge is stored once but treated symmetrically in all queries.
- Can carry a `union_year` (year of marriage).
- Adding this edge triggers **cascade inference** (see Section 6).

Sub-types: `married` (default), `partner`, `divorced`

### SIBLING_OF

```
from_person_id  ──SIBLING_OF──  to_person_id
```

- **Bidirectional** by convention.
- Adding this edge triggers **sibling group merging** (see Section 6).

Sub-types: `full` (default), `half`

### Relationship Ownership

Every relationship row carries a `primary_family_id`. After a merge, all relationships from the absorbed family are retargeted to the surviving family's `primary_family_id`. This is why the graph query only needs to filter by one `primary_family_id` to fetch all relevant edges.

---

## 6. Cascade Inference

When certain relationships are created, the system automatically infers and creates additional relationships to keep the graph consistent. This happens in two places: when adding a relationship normally, and when a merge is accepted.

### On Spouse Addition

When `SPOUSE_OF(A, B)` is created:

> For every child C that A is already a parent of, create `PARENT_OF(B, C)` — unless it already exists.
> Do the same symmetrically: for every child C that B is already a parent of, create `PARENT_OF(A, C)`.

**Why**: If Ramesh and Sunita are recorded as spouses, and Ramesh is already marked as the parent of Vijay, then Sunita should automatically become Vijay's parent too. Without this rule, every user would have to add the mother-child edge manually.

### On Sibling Addition

When `SIBLING_OF(A, B)` is created:

> Collect A's existing sibling group (everyone already linked to A by SIBLING_OF).
> Collect B's existing sibling group (everyone already linked to B by SIBLING_OF).
> Cross-link every member of group A with every member of group B who isn't already linked.

**Example**:
```
Before: A—sibling—X, A—sibling—Y,  B—sibling—P

After SIBLING_OF(A, B):
  A—B  (just added)
  X—B  (new)
  Y—B  (new)
  X—P  (new)
  Y—P  (new)
  A—P  (new)
```

**Why**: Sibling groups in extended families can be large. Requiring every pair to be linked individually would be tedious and error-prone.

### On Merge Accept (Cases 1–6)

A merge transfers all persons and relationships from the absorbed family into the surviving family. After the transfer, new implicit relationships emerge that must be created explicitly. Six inference cases run automatically:

| Case | Situation | Inferred Edge |
|---|---|---|
| 1 | New children + existing spouses | Existing spouse `PARENT_OF` new child |
| 2 | New children + existing children | `SIBLING_OF` between each pair |
| 2b | New children + new children | `SIBLING_OF` between the new arrivals |
| 3 | New spouses + existing children | New spouse `PARENT_OF` existing child |
| 4 | New siblings + existing parents | Existing parent `PARENT_OF` new sibling |
| 5 | New siblings + existing siblings | `SIBLING_OF` between them |
| 5b | New siblings + new siblings | `SIBLING_OF` between the new arrivals |
| 6 | New parents + existing siblings | New parent `PARENT_OF` existing sibling |

All of these insertions are idempotent — a "safe insert" pattern checks for an existing active edge before inserting, so running the logic twice is harmless.

---

## 7. Relationship Labels

When the graph is fetched, every person node receives a `relationshipToSelf` label — a human-readable string like "Father", "Grandmother", "Sister", or "Uncle". These are displayed beneath each node on the canvas.

The labels are **derived at query time** using a breadth-first traversal from the viewer's own node (the "self" anchor):

```
Start: self → label "You"

For each person reached via an edge:
  parent of current    → Father / Mother (based on gender)
  child of current     → Son / Daughter
  spouse of current    → Husband / Wife
  sibling of current   → Brother / Sister

Then for persons reached from a labelled person:
  parent of "Father"   → Grandfather / Grandmother
  spouse of "Father"   → Mother (the other parent)
  sibling of "Father"  → Uncle / Aunt
  child of "Father"    → Brother / Sister (same generation)
  ... and so on
```

The traversal stops when a person is visited for the first time — whichever path reaches them first determines their label. Persons not reachable from the self node receive an empty label and appear as "Relative" if explicitly named.

The label derivation is **perspective-aware**: when viewing someone else's family tree (e.g. via "View his family tree"), the BFS anchors to that person's node, so all labels are shown from their perspective rather than the current user's.

---

## 8. Soft Deletes

Ancestree never permanently deletes persons, families, or relationships from the database. Instead, it sets a `deleted_at` timestamp. Every query that fetches active records includes `WHERE deleted_at IS NULL`.

### Why Soft Deletes

- **Merge safety**: When a merge is accepted, the absorbed person node must be "gone" from the graph but its UUID still needs to be referenced by the `merge_records` table for audit purposes.
- **Audit trail**: The `audit_log` table records every merge action. Hard-deleting the referenced rows would break the audit history.
- **Accidental deletion recovery**: A soft-deleted node can be restored by a database admin without data loss.

### Hard Delete Exception

When a `proxy` or `invited` person with **no remaining relationships** is deleted through the UI, the system does perform a hard delete (`deleted_at = NOW()`) rather than leaving an orphaned row. Claimed nodes are never deleted regardless of relationship count — the user account behind them still exists.

### Cascade Soft Deletes on Person Removal

When a person is deleted via the API, the system first soft-deletes two categories of relationships before deciding whether to soft-delete the person node:

1. `PARENT_OF` edges pointing **to** the deleted person (removes them from their parents' family unit).
2. `SIBLING_OF` edges connected to the deleted person (cleans up sibling group membership).

Edges to their own children (as a parent), their spouse, or their own-family relationships are **preserved** — the person may have a spouse and children that form their own sub-family, and those connections must survive the deletion.

---

## 9. Homes

A **home** is a set of people who physically **live together**, independent of lineage. It is the answer to "who is under one roof?" — a question the family graph cannot answer on its own, because living arrangements cut across bloodlines (a married-in wife, a widowed grandmother, an unrelated tenant relative all share a house but belong to different lineages).

Unlike cluster and family heads, a home is **not derived from any edge**. It is a manual grouping an admin hand-picks; nothing in the graph structure infers it.

### Scope & Ownership

- **Community-scoped** — homes belong to a `community_id`, not to a single family. A home can mix people from different families in the same community.
- **Admin-managed** — only a community admin can create, edit, or delete homes and manage their members.

### Data Model

| Table | Holds |
|---|---|
| `homes` | `id`, `community_id`, `name`, `city` / `state` / `country`, `head_person_id`, `created_by`, `deleted_at` |
| `home_members` | join table: `home_id` ↔ `person_id` (soft-deletable) |

The join table stays many-to-many, but for now **one person can be in only one home**. This is enforced in code (`assertNoneAlreadyInHome`), not by a DB unique constraint, so the rule can be relaxed later without a migration. Adding someone to a home moves them out of any prior home.

### Home Head (`homes.head_person_id`)

Every home has a **head** — the person whose perspective opens when the home is clicked in the community directory. Unlike the cluster/family head, it is **never picked by birthdate**. It is **chosen explicitly**:

- On creation the client **defaults** it to the eldest member by **generation hierarchy** (topmost in the family tree — `PARENT_OF` depth, not `birth_year`), and the admin can override the choice before creating.
- Afterwards a community admin can change the head from the dashboard to any current member.
- Removing the current head from the home **clears** `head_person_id` (the home shows "No head yet") until an admin picks a new one. Adding a member never changes the head.

The head must always be one of the home's active members — the backend rejects any other value.

### Creating & Managing a Home (frontend flow)

Homes are created from a multi-select on the graph canvas (community admin only):

```
Select multiple nodes → "Done"
   → SelectionActionChooser   ("Make a home" vs "Edit details")
   → CreateHomePanel          (head selector, defaulted to the eldest by generation; city required)
   → api.community.createHome({ head_person_id, city, person_ids })
   → POST /api/community/:slug/homes
```

The backend validates every person is a live member of the community, that none already belong to a home, and that the chosen head is one of them, then inserts the `homes` row and `home_members` with the given head.

From the admin dashboard's **Homes** tab an admin can then **change the head** (crown a different member), **add members**, or **remove members**. See `frontend/components/graph/CreateHomePanel.tsx`, `frontend/components/admin/AdminSections.tsx`, and `backend/src/services/community.service.ts` (`createHome`, `updateHome`, `addHomeMembers`, `removeHomeMember`).

### Deletion

Deleting a home soft-deletes the `homes` row. Its **members are detached, not deleted** — the people remain in the graph, simply no longer grouped into that home.

---

*Next section: [Architecture](./architecture.md)*
