CREATE TABLE vpn_route_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 2 AND 120),
  gateway_node_id uuid NOT NULL REFERENCES vpn_nodes(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  config_version bigint NOT NULL DEFAULT 1 CHECK (config_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vpn_route_group_entries (
  group_id uuid NOT NULL REFERENCES vpn_route_groups(id) ON DELETE CASCADE,
  entry_node_id uuid NOT NULL REFERENCES vpn_nodes(id) ON DELETE RESTRICT,
  priority integer NOT NULL CHECK (priority BETWEEN 1 AND 10000),
  PRIMARY KEY (group_id, entry_node_id),
  UNIQUE (group_id, priority)
);

CREATE INDEX vpn_route_group_entries_node_idx
  ON vpn_route_group_entries (entry_node_id);

CREATE TRIGGER vpn_route_groups_set_updated_at
BEFORE UPDATE ON vpn_route_groups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
