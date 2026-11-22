ALTER TABLE vpn_peers
  DROP CONSTRAINT vpn_peers_node_public_key_unique,
  DROP CONSTRAINT vpn_peers_node_ip_unique;

CREATE UNIQUE INDEX vpn_peers_live_node_public_key_idx
  ON vpn_peers (vpn_node_id, public_key)
  WHERE status IN ('pending', 'active');

CREATE UNIQUE INDEX vpn_peers_live_node_ip_idx
  ON vpn_peers (vpn_node_id, assigned_ip)
  WHERE status IN ('pending', 'active');

