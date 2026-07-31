# Community Access Levels

A single, **global** 5-level ladder used by every community. The level *definitions*
live in code (`src/utils/accessLevels.ts`); only the *assignment* (which user is at
which level) is per-community, stored on `community_members.level`.

## The ladder

| Level | Name | Default? | How you get it | Grants (cumulative) |
|:-:|---|:-:|---|---|
| 0 | Viewer | — | owner demotes | View + search only. No writes. |
| 1 | Household | — | owner demotes | + edit self, edit unclaimed nodes **in your home**, add relations there, send merge requests |
| **2** | **Family Editor** | ✅ | automatic on signup/join | + edit / add-relations / create / delete-unclaimed / invite across your whole **cluster** |
| 3 | Admin | — | owner promotes | + cross-cluster edits (unclaimed), create clusters, manage homes/members/fields, revoke & admin-delete, **accept/reject merges on any node**, bulk edit |
| 4 | Owner | — | transfer only (singular) | + force-merge console, promote to admin, community settings, delete/transfer community |

Cumulative: `level >= REQUIRED`.

## Hard walls (never grantable, independent of level)
1. A **claimed** node is editable only by its claimer (`claimed_by === userId`).
2. One account = one node.
3. No hard-delete of your own node, a tree-bridging node, or any claimed node.
4. Exactly one owner (`communities.owner_id`); demote only via transfer.
5. Baseline for everyone (even Viewer→Household): manage your own self-node and
   accept/reject merges **on your own node** (identity ownership).

## Storage & assignment
- `community_members.level smallint NOT NULL DEFAULT 2` (see migration 032).
- Backfill from legacy role: `owner→4, admin→3, else→2`.
- Set on all creation paths: create-community owner→4, signup→2, join→(invite role
  admin→3 else 2).
- **Owner-only** assignment, values **0–3** (level 4 = ownership transfer, separate
  action). `PUT /communities/:slug/members/:uid/level`.
- `communities.owner_id` stays the source of truth for who the owner is; the legacy
  `community_members.role` is kept loosely in sync (admin if level>=3) but `level`
  is authoritative for permission checks.

## Enforcement points
- `assertAdmin` (community.service) → `level >= ADMIN` — covers every existing
  admin-gated endpoint with no caller changes.
- `actAsFamily` middleware (cross-cluster writes) → gated at `level >= ADMIN`.
- `graph.service` `isCommunityAdmin` → `level >= ADMIN` (drives canEdit flags).
- **Graded write-scope** (`services/writeScope.ts`) on every person/relationship
  write: Viewer(0) blocks writes (except own node); Household(1) restricts to own
  node + same-home nodes (via `home_members`); Family Editor(2)+ keeps today's
  cluster scope. Applied in `createPerson` (assertCanCreate), `updatePerson`,
  `deletePerson`, `generateInviteToken`, `bulkUpdatePersons` (Editor+),
  `createRelationship`, `updateRelationship`, `deleteRelationship`,
  `reparentChildren`, `reorderChildren`. Baseline: your own claimed node is always
  writable; the claimed-by-someone-else wall is unchanged.

## Dashboard (next)
Admin → **Access** section: a read-only reference of the 5 levels + this matrix,
and a per-member level dropdown (0–3), **visible/editable to the owner only**.

## Build status
- [x] Level constants + `DEFAULT_LEVEL`
- [x] Migration 032 (column + backfill)
- [x] Default level on create/signup/join
- [x] `assertAdmin` + `actAsFamily` + `graph.service` on level
- [x] Owner-only `setMemberLevel` + route; `level` in `/me`
- [x] Graded write-scope (Viewer block / Household home-scope)
- [ ] Dashboard Access section (frontend)
