CREATE SEQUENCE vpn_route_table_seq START 20000 MAXVALUE 60000;
ALTER TABLE vpn_route_groups
  ADD COLUMN link_cidr cidr,
  ADD COLUMN link_port integer,
  ADD COLUMN routing_table integer NOT NULL DEFAULT nextval('vpn_route_table_seq') UNIQUE,
  ADD COLUMN phase text NOT NULL DEFAULT 'inactive'
    CHECK (phase IN ('inactive', 'staging', 'active', 'failed')),
  ADD COLUMN staged_at timestamptz,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN failure_reason text,
  ADD CONSTRAINT route_link_cidr_check CHECK (link_cidr IS NULL OR
    (family(link_cidr) = 4 AND masklen(link_cidr) = 24 AND link_cidr = network(link_cidr))),
  ADD CONSTRAINT route_link_port_check CHECK (link_port IS NULL OR link_port BETWEEN 1 AND 65535);
CREATE TABLE vpn_route_group_reports (
  group_id uuid NOT NULL REFERENCES vpn_route_groups(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES vpn_nodes(id) ON DELETE CASCADE,
  config_version bigint NOT NULL,
  healthy boolean NOT NULL,
  detail text NOT NULL DEFAULT '',
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, node_id)
);
