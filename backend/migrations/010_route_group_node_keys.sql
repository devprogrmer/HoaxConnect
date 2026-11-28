CREATE TABLE vpn_route_group_node_keys (
  group_id uuid NOT NULL REFERENCES vpn_route_groups(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES vpn_nodes(id) ON DELETE RESTRICT,
  config_version bigint NOT NULL CHECK (config_version > 0),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, node_id)
);
CREATE INDEX vpn_route_group_node_keys_node_idx
  ON vpn_route_group_node_keys (node_id, group_id);
