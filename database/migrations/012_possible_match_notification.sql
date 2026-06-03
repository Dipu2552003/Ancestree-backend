-- Migration 012: possible_match_found notification type + details JSONB

-- Add details column for storing structured per-type payload
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS details JSONB;

-- Extend the type CHECK constraint to include possible_match_found
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'merge_request_received',
    'merge_request_accepted',
    'merge_request_rejected',
    'family_name_changed',
    'claim_suggestion',
    'possible_match_found'
  ));

-- Prevent duplicate possible_match notifications for the same (user, new person, canonical person).
-- ON CONFLICT DO NOTHING in the INSERT will use this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_possible_match_unique
  ON notifications (user_id, related_person_id, (details->>'canonical_person_id'))
  WHERE type = 'possible_match_found';
