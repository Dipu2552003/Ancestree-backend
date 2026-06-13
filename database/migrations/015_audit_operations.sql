-- Phase 1 safety net: group audit rows into logical operations and make them
-- revertible.
--
--   operation_id  — every audit row written inside one withOperation() call
--                   shares this id, so a multi-step action (merge, delete with
--                   edge cleanup, …) is one logical, undoable unit.
--   seq           — monotonic insertion order. created_at cannot order rows
--                   within an operation because NOW() is frozen for the whole
--                   transaction; undo replays rows by seq DESC.
--   reverted_by   — operation_id of the 'undo' operation that reverted this
--                   row. NULL = still in effect. Cleared again when the undo
--                   itself is undone.

ALTER TABLE audit_log ADD COLUMN operation_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE audit_log ADD COLUMN seq BIGSERIAL;
ALTER TABLE audit_log ADD COLUMN reverted_by UUID;

CREATE INDEX idx_audit_log_operation      ON audit_log (operation_id, seq);
CREATE INDEX idx_audit_log_family_created ON audit_log (family_id, created_at DESC);
