CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  merged_into_user_id TEXT,
  FOREIGN KEY (merged_into_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_name_aliases (
  normalized_name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_user_name_aliases_user_id ON user_name_aliases(user_id);

CREATE TABLE IF NOT EXISTS user_profile_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  old_normalized_name TEXT NOT NULL,
  new_normalized_name TEXT NOT NULL,
  renamed_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_profile_audit_user_renamed
  ON user_profile_audit(user_id, renamed_at);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_seed TEXT NOT NULL UNIQUE,
  device_key TEXT,
  device_name TEXT,
  platform TEXT,
  app_version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS traffic_daily (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_device_key ON devices(device_key) WHERE device_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_notices (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  message TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'info' CHECK (tone IN ('info', 'warning')),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_notice_acknowledgements (
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  device_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (user_id, revision, device_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_user_notice_acknowledgements_device
  ON user_notice_acknowledgements(device_id, user_id, revision);

CREATE TABLE IF NOT EXISTS user_notice_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  message TEXT NOT NULL,
  tone TEXT NOT NULL CHECK (tone IN ('info', 'warning')),
  duration_minutes INTEGER NOT NULL
    CHECK (duration_minutes >= 5 AND duration_minutes <= 10080 AND duration_minutes % 5 = 0),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_notice_audit_user_updated
  ON user_notice_audit(user_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_traffic_daily_user_date ON traffic_daily(user_id, date);
CREATE INDEX IF NOT EXISTS idx_traffic_daily_date_user ON traffic_daily(date, user_id);

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
CREATE INDEX IF NOT EXISTS idx_traffic_reports_created_at ON traffic_reports(created_at);

CREATE TABLE IF NOT EXISTS traffic_report_dedup (
  id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  traffic_date TEXT NOT NULL,
  anomaly INTEGER NOT NULL DEFAULT 0 CHECK (anomaly IN (0, 1)),
  legacy_device_id TEXT,
  legacy_upload_delta INTEGER,
  legacy_download_delta INTEGER,
  legacy_reported_at TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);

CREATE TABLE IF NOT EXISTS remote_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscription_url TEXT,
  rule_profile TEXT,
  preferred_region TEXT NOT NULL DEFAULT 'jp',
  region_fallback TEXT NOT NULL DEFAULT 'global',
  preferred_node TEXT,
  preferred_strategy TEXT,
  direct_rules TEXT NOT NULL DEFAULT '[]',
  proxy_rules TEXT NOT NULL DEFAULT '[]',
  anomaly_threshold_bytes INTEGER NOT NULL DEFAULT 1073741824,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  traffic_limit_bytes INTEGER NOT NULL DEFAULT 3380139261952
    CHECK (traffic_limit_bytes > 0 AND traffic_limit_bytes <= 9007199254740991),
  traffic_expires_at TEXT NOT NULL DEFAULT '2026-08-11T20:00:00.000Z',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_remote_config (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER,
  subscription_url TEXT,
  rule_profile TEXT,
  preferred_region TEXT,
  region_fallback TEXT,
  preferred_node TEXT,
  preferred_strategy TEXT,
  direct_rules TEXT,
  proxy_rules TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS traffic_anomalies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  upload_delta INTEGER NOT NULL,
  download_delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_traffic_anomalies_user_created ON traffic_anomalies(user_id, created_at);

CREATE TABLE IF NOT EXISTS user_merge_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  source_user_id TEXT NOT NULL UNIQUE,
  target_user_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  target_name TEXT NOT NULL,
  config_resolution TEXT NOT NULL,
  merged_at TEXT NOT NULL,
  FOREIGN KEY (source_user_id) REFERENCES users(id),
  FOREIGN KEY (target_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_users_merged_into ON users(merged_into_user_id);
