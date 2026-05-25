CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_persons_family      ON persons(primary_family_id);
CREATE INDEX idx_persons_claimed_by  ON persons(claimed_by);
CREATE INDEX idx_persons_node_state  ON persons(node_state);
CREATE INDEX idx_persons_person_code ON persons(person_code);
CREATE INDEX idx_persons_active      ON persons(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_persons_name_trgm   ON persons USING gin(full_name gin_trgm_ops);
CREATE INDEX idx_persons_name_fts    ON persons USING gin(to_tsvector('simple', full_name));

CREATE INDEX idx_rel_from            ON relationships(from_person_id);
CREATE INDEX idx_rel_to              ON relationships(to_person_id);
CREATE INDEX idx_rel_family          ON relationships(primary_family_id);
CREATE INDEX idx_rel_type            ON relationships(rel_type);
CREATE INDEX idx_rel_composite       ON relationships(from_person_id, to_person_id, rel_type);
CREATE INDEX idx_rel_active          ON relationships(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX idx_audit_entity        ON audit_log(entity_id);
CREATE INDEX idx_audit_family        ON audit_log(family_id);
