CREATE TYPE vpn_session_status AS ENUM (
  'provisioning',
  'active',
  'disconnecting',
  'disconnected',
  'revoked',
  'failed',
  'expired'
);

ALTER TABLE vpn_nodes
  ADD COLUMN tunnel_cidr cidr,
  ADD COLUMN listen_port integer,
  ADD COLUMN dns_servers inet[] NOT NULL
    DEFAULT ARRAY['1.1.1.1'::inet, '1.0.0.1'::inet],
  ADD COLUMN egress_interface text,
  ADD COLUMN agent_config_version bigint NOT NULL DEFAULT 1;

ALTER TABLE vpn_nodes
  ADD CONSTRAINT vpn_nodes_tunnel_cidr_check
  CHECK (
    tunnel_cidr IS NULL OR
    (family(tunnel_cidr) = 4 AND masklen(tunnel_cidr) BETWEEN 16 AND 30)
  ),
  ADD CONSTRAINT vpn_nodes_listen_port_check
  CHECK (listen_port IS NULL OR listen_port BETWEEN 1 AND 65535),
  ADD CONSTRAINT vpn_nodes_dns_servers_check
  CHECK (cardinality(dns_servers) BETWEEN 1 AND 4),
  ADD CONSTRAINT vpn_nodes_egress_interface_check
  CHECK (
    egress_interface IS NULL OR
    egress_interface ~ '^[A-Za-z0-9_.:-]{1,32}$'
  ),
  ADD CONSTRAINT vpn_nodes_agent_config_version_check
  CHECK (agent_config_version > 0);

CREATE TABLE vpn_node_enrollment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vpn_node_id uuid NOT NULL
    REFERENCES vpn_nodes(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by_admin_id uuid
    REFERENCES admin_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vpn_node_enrollment_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vpn_node_enrollment_token_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT vpn_node_enrollment_token_used_check
    CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX vpn_node_enrollment_tokens_node_idx
  ON vpn_node_enrollment_tokens (vpn_node_id, expires_at DESC);

CREATE TABLE vpn_node_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vpn_node_id uuid NOT NULL
    REFERENCES vpn_nodes(id) ON DELETE CASCADE,
  public_key_spki text NOT NULL,
  fingerprint_sha256 char(64) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vpn_node_credentials_spki_check
    CHECK (
      char_length(public_key_spki) BETWEEN 24 AND 512 AND
      public_key_spki ~ '^[A-Za-z0-9+/]+={0,2}$'
    ),
  CONSTRAINT vpn_node_credentials_fingerprint_check
    CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vpn_node_credentials_revocation_check
    CHECK (
      (status = 'active' AND revoked_at IS NULL) OR
      (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE INDEX vpn_node_credentials_node_status_idx
  ON vpn_node_credentials (vpn_node_id, status);

CREATE TABLE vpn_node_request_nonces (
  credential_id uuid NOT NULL
    REFERENCES vpn_node_credentials(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  request_timestamp timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, nonce),
  CONSTRAINT vpn_node_request_nonces_value_check
    CHECK (nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  CONSTRAINT vpn_node_request_nonces_expiry_check
    CHECK (expires_at > request_timestamp)
);

CREATE INDEX vpn_node_request_nonces_expiry_idx
  ON vpn_node_request_nonces (expires_at);

CREATE TABLE vpn_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  auth_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  subscription_id uuid NOT NULL
    REFERENCES subscriptions(id) ON DELETE RESTRICT,
  vpn_node_id uuid NOT NULL REFERENCES vpn_nodes(id) ON DELETE RESTRICT,
  vpn_peer_id uuid REFERENCES vpn_peers(id) ON DELETE SET NULL,
  client_public_key text NOT NULL,
  assigned_ip inet NOT NULL,
  status vpn_session_status NOT NULL DEFAULT 'provisioning',
  config_version integer NOT NULL DEFAULT 1,
  lease_expires_at timestamptz NOT NULL,
  activated_at timestamptz,
  disconnected_at timestamptz,
  disconnect_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vpn_sessions_client_public_key_check
    CHECK (client_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  CONSTRAINT vpn_sessions_assigned_ip_check
    CHECK (family(assigned_ip) = 4),
  CONSTRAINT vpn_sessions_config_version_check
    CHECK (config_version > 0),
  CONSTRAINT vpn_sessions_lease_expiry_check
    CHECK (lease_expires_at > created_at),
  CONSTRAINT vpn_sessions_disconnect_state_check
    CHECK (
      (status IN ('provisioning', 'active') AND disconnected_at IS NULL) OR
      (status = 'disconnecting') OR
      (status IN ('disconnected', 'revoked', 'failed', 'expired') AND
       disconnected_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX vpn_sessions_one_live_device_idx
  ON vpn_sessions (device_id)
  WHERE status IN ('provisioning', 'active', 'disconnecting');

CREATE UNIQUE INDEX vpn_sessions_one_live_node_ip_idx
  ON vpn_sessions (vpn_node_id, assigned_ip)
  WHERE status IN ('provisioning', 'active', 'disconnecting');

CREATE UNIQUE INDEX vpn_sessions_one_live_peer_idx
  ON vpn_sessions (vpn_peer_id)
  WHERE vpn_peer_id IS NOT NULL
    AND status IN ('provisioning', 'active', 'disconnecting');

CREATE INDEX vpn_sessions_user_created_idx
  ON vpn_sessions (user_id, created_at DESC);

CREATE INDEX vpn_sessions_node_status_idx
  ON vpn_sessions (vpn_node_id, status, lease_expires_at);

CREATE INDEX vpn_sessions_lease_expiry_idx
  ON vpn_sessions (lease_expires_at)
  WHERE status IN ('provisioning', 'active', 'disconnecting');

CREATE TRIGGER vpn_sessions_set_updated_at
BEFORE UPDATE ON vpn_sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
