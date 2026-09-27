CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM (
  'user',
  'superadmin',
  'admin',
  'support',
  'read_only'
);

CREATE TYPE user_status AS ENUM (
  'active',
  'pending_verification',
  'suspended',
  'deleted'
);

CREATE TYPE session_status AS ENUM (
  'active',
  'rotated',
  'revoked',
  'expired',
  'compromised'
);

CREATE TYPE subscription_status AS ENUM (
  'pending',
  'active',
  'paused',
  'expired',
  'cancelled'
);

CREATE TYPE payment_status AS ENUM (
  'pending',
  'authorized',
  'paid',
  'failed',
  'refunded',
  'cancelled'
);

CREATE TYPE vpn_node_status AS ENUM (
  'offline',
  'online',
  'maintenance',
  'disabled'
);

CREATE TYPE vpn_peer_status AS ENUM (
  'pending',
  'active',
  'revoked',
  'failed'
);

CREATE TYPE ticket_status AS ENUM (
  'open',
  'pending',
  'resolved',
  'closed'
);

CREATE TYPE ticket_priority AS ENUM (
  'low',
  'normal',
  'high',
  'urgent'
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_normalized text NOT NULL,
  username text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'user',
  status user_status NOT NULL DEFAULT 'active',
  email_verified_at timestamptz,
  suspended_at timestamptz,
  suspended_until timestamptz,
  suspension_reason text,
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT users_email_normalized_check
    CHECK (email_normalized = lower(btrim(email_normalized))),
  CONSTRAINT users_username_length_check
    CHECK (char_length(username) BETWEEN 3 AND 64)
);

CREATE UNIQUE INDEX users_email_normalized_unique
  ON users (email_normalized);

CREATE UNIQUE INDEX users_username_lower_unique
  ON users (lower(username));

CREATE INDEX users_status_idx ON users (status);
CREATE INDEX users_role_idx ON users (role);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_uid text NOT NULL,
  name text NOT NULL,
  os text NOT NULL,
  client_version text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_uid_length_check
    CHECK (char_length(device_uid) BETWEEN 16 AND 255),
  CONSTRAINT devices_user_uid_unique
    UNIQUE (user_id, device_uid)
);

CREATE INDEX devices_user_active_idx
  ON devices (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  refresh_token_hash char(64) NOT NULL UNIQUE,
  status session_status NOT NULL DEFAULT 'active',
  parent_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  replaced_by_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_expiry_check CHECK (expires_at > issued_at)
);

CREATE INDEX sessions_user_status_idx
  ON sessions (user_id, status, expires_at);

CREATE INDEX sessions_device_status_idx
  ON sessions (device_id, status, expires_at);

CREATE INDEX sessions_family_idx
  ON sessions (family_id, status);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  duration_days integer NOT NULL CHECK (duration_days > 0),
  traffic_quota_bytes bigint NOT NULL CHECK (traffic_quota_bytes >= 0),
  device_limit integer NOT NULL CHECK (device_limit > 0),
  concurrent_session_limit integer NOT NULL
    CHECK (concurrent_session_limit > 0),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plans_enabled_idx ON plans (enabled);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status subscription_status NOT NULL DEFAULT 'pending',
  starts_at timestamptz,
  ends_at timestamptz,
  traffic_quota_bytes bigint NOT NULL CHECK (traffic_quota_bytes >= 0),
  used_rx_bytes bigint NOT NULL DEFAULT 0 CHECK (used_rx_bytes >= 0),
  used_tx_bytes bigint NOT NULL DEFAULT 0 CHECK (used_tx_bytes >= 0),
  device_limit integer NOT NULL CHECK (device_limit > 0),
  concurrent_session_limit integer NOT NULL
    CHECK (concurrent_session_limit > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_dates_check
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE UNIQUE INDEX subscriptions_one_active_per_user
  ON subscriptions (user_id)
  WHERE status = 'active';

CREATE INDEX subscriptions_user_history_idx
  ON subscriptions (user_id, created_at DESC);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  provider text,
  provider_payment_id text,
  idempotency_key text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL,
  status payment_status NOT NULL DEFAULT 'pending',
  failure_code text,
  failure_message text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payments_provider_reference_unique
  ON payments (provider, provider_payment_id)
  WHERE provider IS NOT NULL AND provider_payment_id IS NOT NULL;

CREATE INDEX payments_user_history_idx
  ON payments (user_id, created_at DESC);

CREATE TABLE vpn_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  country_code char(2) NOT NULL,
  region text NOT NULL,
  city text,
  hostname text NOT NULL UNIQUE,
  public_endpoint text NOT NULL,
  public_key text NOT NULL UNIQUE,
  status vpn_node_status NOT NULL DEFAULT 'offline',
  capacity_peers integer NOT NULL DEFAULT 0 CHECK (capacity_peers >= 0),
  current_peers integer NOT NULL DEFAULT 0 CHECK (current_peers >= 0),
  enabled boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vpn_nodes_capacity_check
    CHECK (current_peers <= capacity_peers OR capacity_peers = 0)
);

CREATE INDEX vpn_nodes_enabled_status_idx
  ON vpn_nodes (enabled, status);

CREATE TABLE vpn_peers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  vpn_node_id uuid NOT NULL REFERENCES vpn_nodes(id) ON DELETE RESTRICT,
  public_key text NOT NULL,
  assigned_ip inet NOT NULL,
  status vpn_peer_status NOT NULL DEFAULT 'pending',
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  provisioned_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vpn_peers_node_public_key_unique
    UNIQUE (vpn_node_id, public_key),
  CONSTRAINT vpn_peers_node_ip_unique
    UNIQUE (vpn_node_id, assigned_ip)
);

CREATE INDEX vpn_peers_device_status_idx
  ON vpn_peers (device_id, status);

CREATE INDEX vpn_peers_node_status_idx
  ON vpn_peers (vpn_node_id, status);

CREATE TABLE traffic_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  vpn_node_id uuid REFERENCES vpn_nodes(id) ON DELETE SET NULL,
  period_date date NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  rx_bytes bigint NOT NULL DEFAULT 0 CHECK (rx_bytes >= 0),
  tx_bytes bigint NOT NULL DEFAULT 0 CHECK (tx_bytes >= 0),
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT traffic_usage_period_check CHECK (period_end > period_start)
);

CREATE UNIQUE INDEX traffic_usage_accounting_unique
  ON traffic_usage (
    user_id,
    device_id,
    session_id,
    vpn_node_id,
    period_start,
    period_end,
    source
  ) NULLS NOT DISTINCT;

CREATE INDEX traffic_usage_user_period_idx
  ON traffic_usage (user_id, period_date, period_start);

CREATE INDEX traffic_usage_device_period_idx
  ON traffic_usage (device_id, period_start);

CREATE INDEX traffic_usage_node_period_idx
  ON traffic_usage (vpn_node_id, period_start)
  WHERE vpn_node_id IS NOT NULL;

CREATE TABLE telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  consent_version text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX telemetry_events_occurred_brin
  ON telemetry_events USING brin (occurred_at);

CREATE INDEX telemetry_events_type_occurred_idx
  ON telemetry_events (event_type, occurred_at DESC);

CREATE INDEX telemetry_events_user_occurred_idx
  ON telemetry_events (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject text NOT NULL,
  category text NOT NULL,
  priority ticket_priority NOT NULL DEFAULT 'normal',
  status ticket_status NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX tickets_status_updated_idx
  ON tickets (status, updated_at DESC);

CREATE INDEX tickets_user_created_idx
  ON tickets (user_id, created_at DESC);

CREATE TABLE ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  sender_role user_role NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ticket_messages_ticket_created_idx
  ON ticket_messages (ticket_id, created_at);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role user_role,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  request_id text NOT NULL,
  ip_address inet,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_actor_created_idx
  ON audit_logs (actor_user_id, created_at DESC);

CREATE INDEX audit_logs_resource_created_idx
  ON audit_logs (resource_type, resource_id, created_at DESC);

CREATE INDEX audit_logs_request_id_idx
  ON audit_logs (request_id);

CREATE TABLE email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_tokens_user_active_idx
  ON email_verification_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_active_idx
  ON password_reset_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER devices_set_updated_at
BEFORE UPDATE ON devices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER plans_set_updated_at
BEFORE UPDATE ON plans
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER subscriptions_set_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER payments_set_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER vpn_nodes_set_updated_at
BEFORE UPDATE ON vpn_nodes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER vpn_peers_set_updated_at
BEFORE UPDATE ON vpn_peers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER traffic_usage_set_updated_at
BEFORE UPDATE ON traffic_usage
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tickets_set_updated_at
BEFORE UPDATE ON tickets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
