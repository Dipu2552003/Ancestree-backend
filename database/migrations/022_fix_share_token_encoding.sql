-- encode(..., 'base64url') requires PG 17; Neon runs PG 16.
-- translate converts standard base64 to URL-safe base64 on all PG versions.
-- 18 random bytes → 24 base64 chars with no padding, so no '=' to strip.
ALTER TABLE families
  ALTER COLUMN share_token
  SET DEFAULT translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_');
