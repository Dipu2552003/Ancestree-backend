ALTER TABLE users ADD CONSTRAINT fk_users_person
  FOREIGN KEY (person_id) REFERENCES persons(id);
