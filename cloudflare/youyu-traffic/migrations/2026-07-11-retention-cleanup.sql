CREATE INDEX IF NOT EXISTS idx_traffic_reports_created_at ON traffic_reports(created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);
