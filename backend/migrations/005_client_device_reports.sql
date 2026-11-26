CREATE TABLE client_device_reports (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  ip_address inet NOT NULL,
  app_state text NOT NULL CHECK (app_state IN ('running', 'closed')),
  permissions jsonb NOT NULL,
  hardware jsonb,
  network jsonb,
  applications jsonb
);

CREATE INDEX client_device_reports_received_idx
  ON client_device_reports (received_at);
