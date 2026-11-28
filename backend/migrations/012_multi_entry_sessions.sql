ALTER TABLE vpn_sessions
  ADD COLUMN connection_group_id uuid;

DROP INDEX vpn_sessions_one_live_device_idx;

CREATE FUNCTION enforce_one_live_device_connection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('provisioning', 'active', 'disconnecting') AND EXISTS (
    SELECT 1 FROM vpn_sessions existing
    WHERE existing.device_id = NEW.device_id
      AND existing.id <> NEW.id
      AND existing.status IN ('provisioning', 'active', 'disconnecting')
      AND (NEW.connection_group_id IS NULL OR
           existing.connection_group_id IS DISTINCT FROM NEW.connection_group_id)
  ) THEN
    RAISE EXCEPTION 'device already has another live VPN connection'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vpn_sessions_one_live_device_connection
BEFORE INSERT OR UPDATE OF device_id, status, connection_group_id ON vpn_sessions
FOR EACH ROW EXECUTE FUNCTION enforce_one_live_device_connection();

CREATE INDEX vpn_sessions_connection_group_idx
  ON vpn_sessions (connection_group_id, status, lease_expires_at)
  WHERE connection_group_id IS NOT NULL;
