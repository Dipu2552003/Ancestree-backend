-- Bio-parent names stored directly on the child when the user records adoption
-- but doesn't (yet) want a separate person node for the biological parents.
-- These are simple text fields — promoted to real person nodes later if needed.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS bio_mother_name TEXT;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS bio_father_name TEXT;
