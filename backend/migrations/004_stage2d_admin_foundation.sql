CREATE TYPE admin_role AS ENUM (
  'superadmin',
  'admin',
  'support',
  'read_only'
);

CREATE TYPE admin_account_status AS ENUM (
  'active',
  'disabled'
);

CREATE TABLE admin_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_normalized text NOT NULL,
  password_hash text NOT NULL,
  role admin_role NOT NULL,
  status admin_account_status NOT NULL DEFAULT 'active',
  failed_login_count integer NOT NULL DEFAULT 0
    CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret_ciphertext bytea,
  mfa_enrolled_at timestamptz,
  created_by_admin_id uuid
    REFERENCES admin_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_accounts_email_normalized_check
    CHECK (email_normalized = lower(btrim(email_normalized))),
  CONSTRAINT admin_accounts_mfa_secret_check
    CHECK (
      (mfa_enabled = false AND mfa_secret_ciphertext IS NULL)
      OR (mfa_enabled = true AND mfa_secret_ciphertext IS NOT NULL)
    )
);

CREATE UNIQUE INDEX admin_accounts_email_unique
  ON admin_accounts (email_normalized);

CREATE INDEX admin_accounts_role_status_idx
  ON admin_accounts (role, status);

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL
    REFERENCES admin_accounts(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_token_hash char(64) NOT NULL
    CHECK (csrf_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by_session_id uuid
    REFERENCES admin_sessions(id) ON DELETE SET NULL,
  ip_address inet,
  user_agent text,
  CONSTRAINT admin_sessions_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX admin_sessions_admin_active_idx
  ON admin_sessions (admin_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE admin_login_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  email_normalized text NOT NULL,
  outcome text NOT NULL
    CHECK (outcome IN ('success', 'failed', 'locked')),
  request_id text NOT NULL,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_login_events_email_created_idx
  ON admin_login_events (email_normalized, created_at DESC);

CREATE INDEX admin_login_events_admin_created_idx
  ON admin_login_events (admin_id, created_at DESC);

CREATE TABLE admin_audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  admin_email text NOT NULL,
  admin_role admin_role NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  reason text,
  request_id text NOT NULL,
  ip_address inet,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_actor_created_idx
  ON admin_audit_logs (admin_id, created_at DESC);

CREATE INDEX admin_audit_resource_created_idx
  ON admin_audit_logs (resource_type, resource_id, created_at DESC);

CREATE INDEX admin_audit_request_id_idx
  ON admin_audit_logs (request_id);

CREATE TABLE admin_provider_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL UNIQUE
    CHECK (provider IN ('sms.ir', 'zarinpal')),
  credentials_ciphertext bytea NOT NULL,
  credentials_nonce bytea NOT NULL
    CHECK (octet_length(credentials_nonce) = 12),
  credentials_tag bytea NOT NULL
    CHECK (octet_length(credentials_tag) = 16),
  masked_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  updated_by_admin_id uuid
    REFERENCES admin_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX traffic_usage_period_date_idx
  ON traffic_usage (period_date, period_start DESC);
