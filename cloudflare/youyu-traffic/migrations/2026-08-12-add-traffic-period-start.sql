UPDATE admin_settings
SET traffic_period_started_at = '2026-08-12T00:25:00.000Z'
WHERE id = 1
  AND (traffic_period_started_at IS NULL OR TRIM(traffic_period_started_at) = '');
