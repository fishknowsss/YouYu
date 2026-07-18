CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_device_key
  ON devices(device_key)
  WHERE device_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_merged_into ON users(merged_into_user_id);

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

UPDATE remote_config
SET version = version + 1,
    rule_profile = CASE
      WHEN rule_profile IN ('smart', 'global') THEN 'ruleset'
      ELSE rule_profile
    END,
    preferred_node = NULL,
    preferred_strategy = NULL,
    direct_rules = '[]',
    proxy_rules = '[]',
    anomaly_threshold_bytes = 1073741824,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE rule_profile IN ('smart', 'global')
   OR preferred_node IS NOT NULL
   OR preferred_strategy IS NOT NULL
   OR direct_rules <> '[]'
   OR proxy_rules <> '[]'
   OR anomaly_threshold_bytes <> 1073741824;

UPDATE user_remote_config
SET rule_profile = CASE
      WHEN rule_profile IN ('smart', 'global') THEN 'ruleset'
      ELSE rule_profile
    END,
    preferred_node = NULL,
    preferred_strategy = NULL,
    direct_rules = NULL,
    proxy_rules = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE rule_profile IN ('smart', 'global')
   OR preferred_node IS NOT NULL
   OR preferred_strategy IS NOT NULL
   OR direct_rules IS NOT NULL
   OR proxy_rules IS NOT NULL;
