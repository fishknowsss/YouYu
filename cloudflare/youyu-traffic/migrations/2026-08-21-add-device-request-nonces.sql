CREATE TABLE IF NOT EXISTS device_request_nonces (
  device_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('config-update')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  claim_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  response_json TEXT,
  PRIMARY KEY (device_id, request_id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_device_request_nonces_expires_at
  ON device_request_nonces(expires_at);
