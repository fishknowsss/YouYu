CREATE TABLE IF NOT EXISTS admin_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  traffic_limit_bytes INTEGER NOT NULL DEFAULT 3380139261952
    CHECK (traffic_limit_bytes > 0 AND traffic_limit_bytes <= 9007199254740991),
  traffic_expires_at TEXT NOT NULL DEFAULT '2026-08-11T20:00:00.000Z',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO admin_settings (id, traffic_limit_bytes, traffic_expires_at, updated_at)
VALUES (1, 3380139261952, '2026-08-11T20:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
