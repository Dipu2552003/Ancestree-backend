-- Who sent the current invite for a node. The invite page's "Invited by" line
-- used persons.created_by, which is whoever first added the node — often not the
-- person who later shared the invite link. Set on every (re)issued invite;
-- NULL for invites sent before this column existed (lookup falls back to
-- created_by for those). ON DELETE SET NULL so removing a user never blocks.
ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS invited_by UUID
  REFERENCES users(id) ON DELETE SET NULL;
