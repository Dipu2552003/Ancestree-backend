-- Migration 010: merge enhancements + notifications

-- Add accepted_by to merge_records (who from the other family clicked Accept)
ALTER TABLE merge_records
  ADD COLUMN IF NOT EXISTS accepted_by UUID REFERENCES users(id);

-- Add head_person_id to families (updated by recomputeFamilyHead after every merge)
ALTER TABLE families
  ADD COLUMN IF NOT EXISTS head_person_id UUID REFERENCES persons(id) DEFERRABLE INITIALLY DEFERRED;

-- Notification types
-- merge_request_received : sent to all members of the canonical family
-- merge_request_accepted  : sent to the merge initiator
-- merge_request_rejected  : sent to the merge initiator
-- family_name_changed     : sent to all members of both families when name changes

CREATE TABLE IF NOT EXISTS notifications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id),
  type            TEXT        NOT NULL
                  CHECK (type IN (
                    'merge_request_received',
                    'merge_request_accepted',
                    'merge_request_rejected',
                    'family_name_changed'
                  )),
  merge_record_id UUID        REFERENCES merge_records(id),
  message         TEXT        NOT NULL,
  is_read         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, is_read);
