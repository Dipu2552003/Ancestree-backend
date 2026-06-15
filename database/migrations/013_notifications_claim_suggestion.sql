-- Migration 011: claim_suggestion notification type + related_person_id column

-- Add related_person_id so claim_suggestion notifications can carry
-- the matching proxy person's ID without embedding it in the message text.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS related_person_id UUID REFERENCES persons(id);

-- Extend the type CHECK constraint to include claim_suggestion.
-- PostgreSQL requires DROP + ADD to change a CHECK constraint.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'merge_request_received',
    'merge_request_accepted',
    'merge_request_rejected',
    'family_name_changed',
    'claim_suggestion'
  ));
