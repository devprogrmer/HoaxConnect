ALTER TABLE vpn_sessions
  ADD COLUMN connection_group_id uuid;

CREATE INDEX vpn_sessions_connection_group_idx
  ON vpn_sessions (connection_group_id, status, lease_expires_at)
  WHERE connection_group_id IS NOT NULL;
