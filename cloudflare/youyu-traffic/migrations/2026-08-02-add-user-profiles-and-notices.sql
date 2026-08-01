CREATE TABLE IF NOT EXISTS user_name_aliases (
  normalized_name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_user_name_aliases_user_id ON user_name_aliases(user_id);

INSERT OR IGNORE INTO user_name_aliases (normalized_name, user_id, created_at)
SELECT normalized_name, COALESCE(merged_into_user_id, id), created_at
FROM users;

UPDATE user_name_aliases
SET user_id = COALESCE((SELECT merged_into_user_id FROM users WHERE id = user_name_aliases.user_id), user_id)
WHERE EXISTS (
  SELECT 1 FROM users
  WHERE users.id = user_name_aliases.user_id AND users.merged_into_user_id IS NOT NULL
);

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
