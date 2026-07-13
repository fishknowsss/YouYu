import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const baseUrl = new URL('../', import.meta.url);

test('legacy database can apply every migration in order', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_seed TEXT NOT NULL UNIQUE, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
    CREATE TABLE traffic_daily (user_id TEXT NOT NULL, device_id TEXT NOT NULL, date TEXT NOT NULL, upload_bytes INTEGER NOT NULL, download_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, device_id, date));
  `);

  for (const name of [
    '2026-07-03-add-remote-subscription-url.sql',
    '2026-07-08-security-and-idempotency.sql',
    '2026-07-11-retention-cleanup.sql'
  ]) {
    database.exec(readFileSync(new URL(`migrations/${name}`, baseUrl), 'utf8'));
  }

  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const table of ['remote_config', 'user_remote_config', 'traffic_anomalies', 'traffic_reports', 'rate_limits']) {
    assert.ok(tables.includes(table), `${table} should exist`);
  }
  const remoteColumns = database
    .prepare('PRAGMA table_info(remote_config)')
    .all()
    .map((row) => row.name);
  assert.ok(remoteColumns.includes('subscription_url'));
  assert.ok(remoteColumns.includes('anomaly_threshold_bytes'));
  database.close();
});
