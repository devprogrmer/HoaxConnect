ALTER TABLE vpn_nodes
  ADD COLUMN agent_version text,
  ADD COLUMN load_percent numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN agent_started_at timestamptz,
  ADD COLUMN last_agent_ip inet;

ALTER TABLE vpn_nodes
  ADD CONSTRAINT vpn_nodes_agent_version_check
  CHECK (
    agent_version IS NULL OR
    agent_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$'
  ),
  ADD CONSTRAINT vpn_nodes_load_percent_check
  CHECK (load_percent >= 0 AND load_percent <= 100);
