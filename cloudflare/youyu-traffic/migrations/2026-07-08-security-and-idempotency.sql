CREATE TABLE IF NOT EXISTS traffic_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  upload_delta INTEGER NOT NULL,
  download_delta INTEGER NOT NULL,
  reported_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_traffic_reports_user_created ON traffic_reports(user_id, created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
