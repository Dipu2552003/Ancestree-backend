-- Permanent reusable join code on each community.
-- Unlike community_invites (single-use targeted codes), this is always present
-- and lets admins re-share a link at any time without creating a new invite.
ALTER TABLE communities
  ADD COLUMN join_code TEXT NOT NULL UNIQUE
    DEFAULT encode(gen_random_bytes(10), 'hex');

CREATE UNIQUE INDEX idx_communities_join_code ON communities (join_code);
