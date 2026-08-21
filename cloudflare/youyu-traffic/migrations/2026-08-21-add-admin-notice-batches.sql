CREATE TABLE IF NOT EXISTS admin_notice_batches (
  request_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('broadcast', 'reset')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  target_count INTEGER NOT NULL CHECK (target_count > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS admin_notice_batch_targets (
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  result_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (request_id, user_id),
  FOREIGN KEY (request_id) REFERENCES admin_notice_batches(request_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_admin_notice_batch_targets_status
  ON admin_notice_batch_targets(request_id, status);
