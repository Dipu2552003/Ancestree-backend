BEGIN;

-- 1) Rename the target family to "Khandelwal" with prefix "KHAN"
UPDATE families
   SET name = 'Khandelwal',
       name_prefix = 'KHAN',
       updated_at = NOW()
 WHERE id = '3749529e-f62e-4132-8837-70efe64f657e';

-- 2) Move every person into the Khandelwal family
UPDATE persons
   SET primary_family_id = '3749529e-f62e-4132-8837-70efe64f657e',
       updated_at = NOW();

-- 3) Move every relationship into the Khandelwal family
UPDATE relationships
   SET primary_family_id = '3749529e-f62e-4132-8837-70efe64f657e';

-- 4) Clear stale head_person_id on the now-empty families
UPDATE families
   SET head_person_id = NULL
 WHERE id <> '3749529e-f62e-4132-8837-70efe64f657e';

-- 5) Make every user a member of the Khandelwal family (admin if family creator, else member)
INSERT INTO family_members (family_id, user_id, role)
SELECT '3749529e-f62e-4132-8837-70efe64f657e', u.id,
       CASE WHEN u.id = (SELECT created_by FROM families WHERE id = '3749529e-f62e-4132-8837-70efe64f657e')
            THEN 'admin' ELSE 'member' END
  FROM users u
ON CONFLICT (family_id, user_id) DO NOTHING;

COMMIT;
