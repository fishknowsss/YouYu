UPDATE admin_settings
SET traffic_expires_at = '2026-08-11T20:00:00.000Z'
WHERE id = 1 AND (traffic_expires_at IS NULL OR TRIM(traffic_expires_at) = '');

CREATE INDEX IF NOT EXISTS idx_traffic_daily_date_user ON traffic_daily(date, user_id);
