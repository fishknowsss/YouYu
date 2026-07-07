CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_seed TEXT NOT NULL UNIQUE,
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
CREATE INDEX IF NOT EXISTS idx_traffic_daily_user_date ON traffic_daily(user_id, date);

CREATE TABLE IF NOT EXISTS remote_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscription_url TEXT,
  rule_profile TEXT,
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
