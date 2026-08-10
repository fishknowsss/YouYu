CREATE TABLE IF NOT EXISTS remote_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscription_url TEXT,
  rule_profile TEXT,
  preferred_region TEXT,
  region_fallback TEXT,
  preferred_node TEXT,
  preferred_strategy TEXT,
  direct_rules TEXT NOT NULL DEFAULT '[]',
  proxy_rules TEXT NOT NULL DEFAULT '[]',
  anomaly_threshold_bytes INTEGER NOT NULL DEFAULT 1073741824,
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

CREATE INDEX IF NOT EXISTS idx_traffic_anomalies_user_created
  ON traffic_anomalies(user_id, created_at);
