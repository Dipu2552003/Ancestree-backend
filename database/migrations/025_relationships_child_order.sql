-- Manual sibling order when birth years are unknown. Set on PARENT_OF edges
-- (1 = eldest); NULL = no manual order, layout falls back to age/name. Kept on
-- the edge (not the person) so half-sibling sets order independently; the
-- reorder endpoint writes the same value to both parents' edges of a child.
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS child_order INTEGER;
