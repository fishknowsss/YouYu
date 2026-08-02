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
