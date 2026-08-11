import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const baseUrl = new URL('../', import.meta.url);
const currentSchema = readFileSync(new URL('schema.sql', baseUrl), 'utf8');

test('legacy database can apply every migration in order', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_seed TEXT NOT NULL UNIQUE, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
    CREATE TABLE traffic_daily (user_id TEXT NOT NULL, device_id TEXT NOT NULL, date TEXT NOT NULL, upload_bytes INTEGER NOT NULL, download_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, device_id, date));
    ALTER TABLE users ADD COLUMN merged_into_user_id TEXT REFERENCES users(id);
    ALTER TABLE users ADD COLUMN can_edit_managed_config INTEGER NOT NULL DEFAULT 0 CHECK (can_edit_managed_config IN (0, 1));
    ALTER TABLE devices ADD COLUMN device_key TEXT;
  `);

  for (const name of [
    '2026-07-03-add-remote-subscription-url.sql',
    '2026-07-08-security-and-idempotency.sql',
    '2026-07-11-retention-cleanup.sql',
    '2026-07-19-device-identity-and-user-merge.sql',
    '2026-07-19-add-admin-traffic-limit.sql',
    '2026-07-20-add-traffic-expiry-and-trend-index.sql',
    '2026-08-01-persist-traffic-report-dedup.sql',
    '2026-08-02-add-user-profiles-and-notices.sql',
    '2026-08-02-add-user-notice-audit.sql',
    '2026-08-10-add-node-region-policy.sql',
    '2026-08-11-add-managed-config-permission.sql'
  ]) {
    database.exec(readFileSync(new URL(`migrations/${name}`, baseUrl), 'utf8'));
  }

  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const table of [
    'remote_config',
    'admin_settings',
    'user_remote_config',
    'traffic_anomalies',
    'traffic_reports',
    'traffic_report_dedup',
    'rate_limits',
    'user_name_aliases',
    'user_profile_audit',
    'user_notices',
    'user_notice_acknowledgements',
    'user_notice_audit'
  ]) {
    assert.ok(tables.includes(table), `${table} should exist`);
  }
  const remoteColumns = database
    .prepare('PRAGMA table_info(remote_config)')
    .all()
    .map((row) => row.name);
  assert.ok(remoteColumns.includes('subscription_url'));
  assert.ok(remoteColumns.includes('preferred_region'));
  assert.ok(remoteColumns.includes('region_fallback'));
  assert.ok(remoteColumns.includes('anomaly_threshold_bytes'));
  assert.equal(
    database.prepare('SELECT can_edit_managed_config FROM users LIMIT 1').get()?.can_edit_managed_config ?? 0,
    0
  );
  assert.deepEqual(
    { ...database.prepare('SELECT preferred_region, region_fallback FROM remote_config WHERE id = 1').get() },
    { preferred_region: 'jp', region_fallback: 'global' }
  );
  assert.equal(
    database.prepare('SELECT traffic_expires_at FROM admin_settings WHERE id = 1').get().traffic_expires_at,
    '2026-08-11T20:00:00.000Z'
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_traffic_daily_date_user'"
      )
      .get().count,
    1
  );
  database.close();
});

test('profile migration points a merged source name directly at its canonical target', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(currentSchema);
  database.exec(`
    INSERT INTO users (id, name, normalized_name, status, created_at, merged_into_user_id)
    VALUES
      ('target-user', 'Target', 'target', 'active', '2026-07-01T00:00:00.000Z', NULL),
      ('source-user', 'Source', 'source', 'merged', '2026-07-02T00:00:00.000Z', 'target-user');
    INSERT INTO user_name_aliases (normalized_name, user_id, created_at)
    VALUES ('source', 'source-user', '2026-07-02T00:00:00.000Z');
  `);
  const migration = readFileSync(new URL('migrations/2026-08-02-add-user-profiles-and-notices.sql', baseUrl), 'utf8');

  database.exec(migration);
  assert.deepEqual(
    database
      .prepare('SELECT normalized_name, user_id FROM user_name_aliases ORDER BY normalized_name')
      .all()
      .map((row) => ({ ...row })),
    [
      { normalized_name: 'source', user_id: 'target-user' },
      { normalized_name: 'target', user_id: 'target-user' }
    ]
  );
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM user_name_aliases WHERE normalized_name = ? AND user_id <> ?')
      .get('source', 'target-user').count,
    0
  );
  database.close();
});

test('managed config permission survives repeated migration and empty legacy overrides are removed', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(currentSchema);
  database.exec(`
    INSERT INTO users (id, name, normalized_name, status, created_at)
    VALUES
      ('user-1', 'Alice', 'alice', 'active', '2026-08-11T00:00:00.000Z'),
      ('user-2', 'Bob', 'bob', 'active', '2026-08-11T00:00:00.000Z');
    INSERT INTO user_remote_config (user_id, updated_at)
    VALUES ('user-1', '2026-08-11T00:00:00.000Z');
    INSERT INTO user_remote_config (user_id, rule_profile, updated_at)
    VALUES ('user-2', 'subscription', '2026-08-11T00:00:00.000Z');
  `);
  assert.equal(
    database.prepare('SELECT can_edit_managed_config FROM users WHERE id = ?').get('user-1').can_edit_managed_config,
    0
  );
  database.prepare('UPDATE users SET can_edit_managed_config = 1 WHERE id = ?').run('user-1');
  const migration = readFileSync(new URL('migrations/2026-08-11-add-managed-config-permission.sql', baseUrl), 'utf8');
  database.exec(migration);
  database.exec(migration);
  assert.equal(
    database.prepare('SELECT can_edit_managed_config FROM users WHERE id = ?').get('user-1').can_edit_managed_config,
    1
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM user_remote_config WHERE user_id = ?').get('user-1').count,
    0
  );
  assert.equal(
    database.prepare('SELECT rule_profile FROM user_remote_config WHERE user_id = ?').get('user-2').rule_profile,
    'subscription'
  );
  database.close();
});

test('traffic report dedup migration backfills audit ids once without changing traffic totals', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(currentSchema);
  database.exec(`
    DROP TABLE traffic_report_dedup;
    INSERT INTO users (id, name, normalized_name, status, created_at)
    VALUES ('user-1', 'Alice', 'alice', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO devices (id, user_id, device_seed, first_seen_at, last_seen_at)
    VALUES ('device-1', 'user-1', 'seed-1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO traffic_reports
      (id, user_id, device_id, upload_delta, download_delta, reported_at, created_at)
    VALUES
      ('report-1', 'user-1', 'device-1', 1073741824, 200, '2026-07-01T00:00:00.000Z', '2026-07-01T20:00:00.000Z');
    INSERT INTO traffic_daily
      (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
    VALUES
      ('user-1', 'device-1', '2026-07-02', 1073741824, 200, '2026-07-01T20:00:00.000Z');
  `);
  const migration = readFileSync(new URL('migrations/2026-08-01-persist-traffic-report-dedup.sql', baseUrl), 'utf8');

  database.exec(migration);
  assert.deepEqual(
    { ...database.prepare('SELECT * FROM traffic_report_dedup WHERE id = ?').get('report-1') },
    {
      id: 'report-1',
      payload_hash: null,
      traffic_date: '2026-07-02',
      anomaly: 1,
      legacy_device_id: 'device-1',
      legacy_upload_delta: 1073741824,
      legacy_download_delta: 200,
      legacy_reported_at: '2026-07-01T00:00:00.000Z'
    }
  );
  database
    .prepare(
      `UPDATE traffic_report_dedup
       SET payload_hash = ?, legacy_device_id = NULL, legacy_upload_delta = NULL,
           legacy_download_delta = NULL, legacy_reported_at = NULL
       WHERE id = ?`
    )
    .run('a'.repeat(64), 'report-1');
  database.exec(migration);
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT payload_hash, legacy_device_id, legacy_upload_delta, legacy_download_delta, legacy_reported_at
           FROM traffic_report_dedup WHERE id = ?`
        )
        .get('report-1')
    },
    {
      payload_hash: 'a'.repeat(64),
      legacy_device_id: null,
      legacy_upload_delta: null,
      legacy_download_delta: null,
      legacy_reported_at: null
    }
  );
  assert.deepEqual(
    { ...database.prepare('SELECT upload_bytes, download_bytes FROM traffic_daily').get() },
    {
      upload_bytes: 1073741824,
      download_bytes: 200
    }
  );
  database.close();
});

test('device identity and user merge migration normalizes removed remote controls', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(currentSchema);
  database.exec(`
    INSERT INTO users (id, name, normalized_name, status, created_at)
    VALUES ('user-1', 'Alice', 'alice', 'active', '2026-07-19T00:00:00.000Z');
    INSERT INTO remote_config
      (id, version, enabled, rule_profile, preferred_node, preferred_strategy, direct_rules, proxy_rules, anomaly_threshold_bytes, updated_at)
    VALUES
      (1, 1, 1, 'smart', 'Node A', 'manual', '["DOMAIN,direct.test"]', '["DOMAIN,proxy.test"]', 1024, '2026-07-19T00:00:00.000Z');
    INSERT INTO user_remote_config
      (user_id, rule_profile, preferred_node, preferred_strategy, direct_rules, proxy_rules, updated_at)
    VALUES
      ('user-1', 'global', 'Node B', 'auto', '["DOMAIN,direct.test"]', '["DOMAIN,proxy.test"]', '2026-07-19T00:00:00.000Z');
  `);

  const migration = readFileSync(new URL('migrations/2026-07-19-device-identity-and-user-merge.sql', baseUrl), 'utf8');
  database.exec(migration);
  database.exec(`
    UPDATE remote_config SET updated_at = 'after-first-run';
    UPDATE user_remote_config SET updated_at = 'after-first-run';
  `);
  database.exec(migration);

  const global = database.prepare('SELECT * FROM remote_config WHERE id = 1').get();
  assert.equal(global.rule_profile, 'ruleset');
  assert.equal(global.preferred_node, null);
  assert.equal(global.preferred_strategy, null);
  assert.equal(global.direct_rules, '[]');
  assert.equal(global.proxy_rules, '[]');
  assert.equal(global.anomaly_threshold_bytes, 1024 * 1024 * 1024);
  assert.equal(global.version, 2);
  assert.equal(global.updated_at, 'after-first-run');
  const user = database.prepare('SELECT * FROM user_remote_config WHERE user_id = ?').get('user-1');
  assert.equal(user.rule_profile, 'ruleset');
  assert.equal(user.preferred_node, null);
  assert.equal(user.preferred_strategy, null);
  assert.equal(user.direct_rules, null);
  assert.equal(user.proxy_rules, null);
  assert.equal(user.updated_at, 'after-first-run');

  const mergeTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_merge_audit'")
    .get();
  const deviceKeyIndex = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_devices_device_key'")
    .get();
  assert.equal(mergeTable.name, 'user_merge_audit');
  assert.equal(deviceKeyIndex.name, 'idx_devices_device_key');
  database.close();
});

test('admin settings migration installs the default traffic limit once and preserves later changes', () => {
  const database = new DatabaseSync(':memory:');
  const migration = readFileSync(new URL('migrations/2026-07-19-add-admin-traffic-limit.sql', baseUrl), 'utf8');

  database.exec(migration);
  assert.equal(
    database.prepare('SELECT traffic_limit_bytes FROM admin_settings WHERE id = 1').get().traffic_limit_bytes,
    3380139261952
  );
  assert.equal(
    database.prepare('SELECT traffic_expires_at FROM admin_settings WHERE id = 1').get().traffic_expires_at,
    '2026-08-11T20:00:00.000Z'
  );

  database
    .prepare('UPDATE admin_settings SET traffic_limit_bytes = ?, traffic_expires_at = ? WHERE id = 1')
    .run(987654321, '2026-09-01T00:00:00.000Z');
  database.exec(migration);
  assert.equal(
    database.prepare('SELECT traffic_limit_bytes FROM admin_settings WHERE id = 1').get().traffic_limit_bytes,
    987654321
  );
  assert.equal(
    database.prepare('SELECT traffic_expires_at FROM admin_settings WHERE id = 1').get().traffic_expires_at,
    '2026-09-01T00:00:00.000Z'
  );
  database.close();
});
