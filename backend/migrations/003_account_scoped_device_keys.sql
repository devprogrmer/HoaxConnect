DROP INDEX IF EXISTS devices_key_fingerprint_unique;

CREATE UNIQUE INDEX devices_user_key_fingerprint_unique
  ON devices (user_id, key_fingerprint)
  WHERE key_fingerprint IS NOT NULL;
