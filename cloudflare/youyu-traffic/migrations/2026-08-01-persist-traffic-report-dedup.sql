CREATE TABLE IF NOT EXISTS traffic_report_dedup (
  id TEXT PRIMARY KEY,
  payload_hash TEXT,
  traffic_date TEXT NOT NULL,
  anomaly INTEGER NOT NULL DEFAULT 0 CHECK (anomaly IN (0, 1)),
  legacy_device_id TEXT,
  legacy_upload_delta INTEGER,
  legacy_download_delta INTEGER,
  legacy_reported_at TEXT,
  CHECK (payload_hash IS NULL OR length(payload_hash) = 64),
  CHECK (
    payload_hash IS NOT NULL OR
    (
      legacy_device_id IS NOT NULL AND
      legacy_upload_delta IS NOT NULL AND
      legacy_download_delta IS NOT NULL AND
      legacy_reported_at IS NOT NULL
    )
  )
) WITHOUT ROWID;

-- Existing audit rows predate the canonical payload hash. Preserve the mutation-bearing
-- fields so the first compatible retry can seal an exact hash without recounting traffic.
INSERT OR IGNORE INTO traffic_report_dedup
  (
    id,
    payload_hash,
    traffic_date,
    anomaly,
    legacy_device_id,
    legacy_upload_delta,
    legacy_download_delta,
    legacy_reported_at
  )
SELECT
  id,
  NULL,
  COALESCE(strftime('%Y-%m-%d', created_at, '+8 hours'), substr(created_at, 1, 10), '1970-01-01'),
  CASE WHEN upload_delta >= 1073741824 OR download_delta >= 1073741824 THEN 1 ELSE 0 END,
  device_id,
  upload_delta,
  download_delta,
  reported_at
FROM traffic_reports;
