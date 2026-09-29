ALTER TYPE user_status
  ADD VALUE IF NOT EXISTS 'banned';

ALTER TABLE users
  ADD COLUMN phone text,
  ADD COLUMN phone_normalized text,
  ADD COLUMN phone_verified_at timestamptz,
  ADD COLUMN banned_at timestamptz,
  ADD COLUMN ban_reason text;

ALTER TABLE users
  ADD CONSTRAINT users_phone_normalized_check
  CHECK (
    phone_normalized IS NULL OR
    phone_normalized ~ '^\+[1-9][0-9]{7,14}$'
  );

CREATE UNIQUE INDEX users_verified_phone_unique
  ON users (phone_normalized)
  WHERE phone_verified_at IS NOT NULL;

ALTER TABLE devices
  ADD COLUMN platform text,
  ADD COLUMN os_version text,
  ADD COLUMN architecture text,
  ADD COLUMN public_key_spki text,
  ADD COLUMN key_fingerprint char(64),
  ADD COLUMN key_algorithm text,
  ADD COLUMN proof_verified_at timestamptz,
  ADD COLUMN banned_at timestamptz,
  ADD COLUMN ban_reason text;

ALTER TABLE devices
  ADD CONSTRAINT devices_key_algorithm_check
  CHECK (
    key_algorithm IS NULL OR
    key_algorithm = 'Ed25519'
  );

ALTER TABLE devices
  ADD CONSTRAINT devices_key_fingerprint_check
  CHECK (
    key_fingerprint IS NULL OR
    key_fingerprint ~ '^[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX devices_key_fingerprint_unique
  ON devices (key_fingerprint)
  WHERE key_fingerprint IS NOT NULL;

ALTER TABLE sessions
  ADD COLUMN proof_verified_at timestamptz;

CREATE TYPE device_challenge_purpose AS ENUM (
  'enrollment',
  'login',
  'refresh',
  'key_rotation'
);

CREATE TABLE device_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid
    REFERENCES devices(id) ON DELETE CASCADE,
  session_id uuid
    REFERENCES sessions(id) ON DELETE CASCADE,
  purpose device_challenge_purpose NOT NULL,
  device_uid text NOT NULL,
  key_fingerprint char(64) NOT NULL,
  challenge_hash char(64) NOT NULL UNIQUE,
  flow_token_hash char(64) NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0
    CHECK (failed_attempts >= 0),
  max_attempts integer NOT NULL
    CHECK (max_attempts > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_challenges_expiry_check
    CHECK (expires_at > issued_at),
  CONSTRAINT device_challenges_fingerprint_check
    CHECK (key_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX device_challenges_active_user_idx
  ON device_challenges (user_id, purpose, expires_at)
  WHERE consumed_at IS NULL
    AND invalidated_at IS NULL;

CREATE INDEX device_challenges_expiry_idx
  ON device_challenges (expires_at);

CREATE TABLE device_limit_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  device_uid text NOT NULL,
  device_name text,
  platform text,
  os_version text,
  architecture text,
  client_version text,
  effective_limit integer NOT NULL
    CHECK (effective_limit > 0),
  active_device_count integer NOT NULL
    CHECK (active_device_count >= 0),
  decision text NOT NULL
    CHECK (decision IN ('rejected', 'held', 'allowed')),
  ip_address inet,
  user_agent text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_limit_violations_user_created_idx
  ON device_limit_violations (user_id, created_at DESC);

CREATE TABLE policy_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid
    REFERENCES devices(id) ON DELETE CASCADE,
  session_id uuid
    REFERENCES sessions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  reason text,
  auth_version integer NOT NULL
    CHECK (auth_version > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT policy_events_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX policy_events_user_id_idx
  ON policy_events (user_id, id);

CREATE INDEX policy_events_expiry_idx
  ON policy_events (expires_at);

CREATE TABLE refresh_rotation_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_family_id uuid NOT NULL,
  previous_session_id uuid NOT NULL
    REFERENCES sessions(id) ON DELETE CASCADE,
  replacement_session_id uuid NOT NULL
    REFERENCES sessions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL
    REFERENCES devices(id) ON DELETE CASCADE,
  recovery_id uuid NOT NULL UNIQUE,
  recovery_secret_hash char(64) NOT NULL,
  response_ciphertext bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_recovery_previous_unique
    UNIQUE (previous_session_id),
  CONSTRAINT refresh_recovery_replacement_unique
    UNIQUE (replacement_session_id),
  CONSTRAINT refresh_recovery_session_pair_check
    CHECK (previous_session_id <> replacement_session_id),
  CONSTRAINT refresh_recovery_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT refresh_recovery_hash_check
    CHECK (recovery_secret_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX refresh_recovery_family_idx
  ON refresh_rotation_recoveries (
    session_family_id,
    expires_at
  );

CREATE INDEX refresh_recovery_cleanup_idx
  ON refresh_rotation_recoveries (
    expires_at,
    consumed_at
  );
