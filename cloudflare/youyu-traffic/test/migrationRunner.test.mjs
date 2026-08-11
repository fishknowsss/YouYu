import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  applyWorkerMigrations,
  createWranglerRunner,
  parseMigrationArgs,
  planWorkerMigrations
} from '../migrations/apply.mjs';

const currentSchema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

test('migration runner repairs legacy subscription columns once and preserves their values', async (context) => {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_seed TEXT NOT NULL UNIQUE, device_name TEXT, platform TEXT,
      app_version TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    );
    CREATE TABLE traffic_daily (
      user_id TEXT NOT NULL, device_id TEXT NOT NULL, date TEXT NOT NULL, upload_bytes INTEGER NOT NULL DEFAULT 0,
      download_bytes INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, device_id, date)
    );
    CREATE TABLE remote_config (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
      rule_profile TEXT, preferred_node TEXT, preferred_strategy TEXT, direct_rules TEXT NOT NULL DEFAULT '[]',
      proxy_rules TEXT NOT NULL DEFAULT '[]', anomaly_threshold_bytes INTEGER NOT NULL DEFAULT 1073741824,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE user_remote_config (
      user_id TEXT PRIMARY KEY, enabled INTEGER, rule_profile TEXT, preferred_node TEXT, preferred_strategy TEXT,
      direct_rules TEXT, proxy_rules TEXT, updated_at TEXT NOT NULL
    );
    INSERT INTO remote_config (id, updated_at) VALUES (1, '2026-07-13T00:00:00.000Z');
    INSERT INTO users (id, name, normalized_name, status, created_at)
      VALUES ('user-1', 'Alice', 'alice', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO user_remote_config (user_id, updated_at) VALUES ('user-1', '2026-07-13T00:00:00.000Z');
    CREATE INDEX idx_devices_user_id ON devices(user_id);
    CREATE INDEX idx_traffic_daily_user_date ON traffic_daily(user_id, date);
  `);
  const runner = createSqliteRunner(database);

  const plan = await planWorkerMigrations(runner);
  assert.ok(plan.missingTables.includes('admin_settings'));
  assert.ok(plan.missingTables.includes('traffic_report_dedup'));
  assert.deepEqual(plan.subscriptionColumnsToAdd, [
    'remote_config.subscription_url',
    'user_remote_config.subscription_url'
  ]);
  assert.deepEqual(plan.columnsToAdd, [
    'users.can_edit_managed_config',
    'users.merged_into_user_id',
    'devices.device_key',
    'remote_config.subscription_url',
    'remote_config.preferred_region',
    'remote_config.region_fallback',
    'user_remote_config.subscription_url',
    'user_remote_config.preferred_region',
    'user_remote_config.region_fallback'
  ]);

  await applyWorkerMigrations(runner);
  database.prepare('UPDATE remote_config SET subscription_url = ? WHERE id = 1').run('https://example.com/global');
  database.prepare('UPDATE admin_settings SET traffic_limit_bytes = ? WHERE id = 1').run(987654321);
  database
    .prepare('INSERT INTO user_remote_config (user_id, subscription_url, updated_at) VALUES (?, ?, ?)')
    .run('user-1', 'https://example.com/alice', '2026-07-13T01:00:00.000Z');
  await applyWorkerMigrations(runner);

  assert.equal(runner.alterStatements.length, 9);
  assert.equal(
    database.prepare('SELECT subscription_url FROM remote_config WHERE id = 1').get().subscription_url,
    'https://example.com/global'
  );
  assert.equal(
    database.prepare('SELECT subscription_url FROM user_remote_config WHERE user_id = ?').get('user-1')
      .subscription_url,
    'https://example.com/alice'
  );
  assert.equal(
    database.prepare('SELECT traffic_limit_bytes FROM admin_settings WHERE id = 1').get().traffic_limit_bytes,
    987654321
  );
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'traffic_report_dedup'")
      .get().count,
    1
  );
});

test('migration CLI requires an explicit target and operation', () => {
  assert.throws(() => parseMigrationArgs([]), /target/);
  assert.throws(() => parseMigrationArgs(['--remote']), /operation/);
  assert.deepEqual(parseMigrationArgs(['--local', '--dry-run']), { mode: 'local', operation: 'dry-run' });
  assert.deepEqual(parseMigrationArgs(['--remote', '--apply']), { mode: 'remote', operation: 'apply' });
});

test('Wrangler runner retries transient API failures but not SQL failures', async () => {
  let transientAttempts = 0;
  const transientRunner = createWranglerRunner('remote', () => {
    transientAttempts += 1;
    return transientAttempts === 1
      ? { status: 1, stdout: '', stderr: 'Authentication error [code: 10000]' }
      : { status: 0, stdout: '[]', stderr: '' };
  });
  await transientRunner.executeSql('SELECT 1');
  assert.equal(transientAttempts, 2);

  let sqlAttempts = 0;
  const sqlRunner = createWranglerRunner('remote', () => {
    sqlAttempts += 1;
    return { status: 1, stdout: '', stderr: 'SQLITE_ERROR: no such table' };
  });
  await assert.rejects(() => sqlRunner.executeSql('SELECT 1'), /SQLITE_ERROR/);
  assert.equal(sqlAttempts, 1);
});

test('migration runner repairs the quota expiry column and preserves later settings', async (context) => {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  database.exec(currentSchema);
  database.exec(`
    DROP TABLE admin_settings;
    CREATE TABLE admin_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      traffic_limit_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO admin_settings (id, traffic_limit_bytes, updated_at)
    VALUES (1, 123456789, '2026-07-20T00:00:00.000Z');
  `);
  const runner = createSqliteRunner(database);
  const plan = await planWorkerMigrations(runner);
  assert.ok(plan.columnsToAdd.includes('admin_settings.traffic_expires_at'));

  await applyWorkerMigrations(runner);
  assert.equal(
    database.prepare('SELECT traffic_expires_at FROM admin_settings WHERE id = 1').get().traffic_expires_at,
    '2026-08-11T20:00:00.000Z'
  );
  database.prepare('UPDATE admin_settings SET traffic_expires_at = ? WHERE id = 1').run('2026-09-01T00:00:00.000Z');
  await applyWorkerMigrations(runner);
  assert.equal(
    database.prepare('SELECT traffic_expires_at FROM admin_settings WHERE id = 1').get().traffic_expires_at,
    '2026-09-01T00:00:00.000Z'
  );
  assert.equal(runner.alterStatements.filter((sql) => sql.includes('traffic_expires_at')).length, 1);
});

test('migration runner refuses a remote-config-only database before writing', async (context) => {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  database.exec(`
    CREATE TABLE remote_config (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
      subscription_url TEXT, rule_profile TEXT, preferred_node TEXT, preferred_strategy TEXT,
      direct_rules TEXT NOT NULL DEFAULT '[]', proxy_rules TEXT NOT NULL DEFAULT '[]',
      anomaly_threshold_bytes INTEGER NOT NULL DEFAULT 1073741824, updated_at TEXT NOT NULL
    );
    CREATE TABLE user_remote_config (
      user_id TEXT PRIMARY KEY, enabled INTEGER, subscription_url TEXT, rule_profile TEXT, preferred_node TEXT,
      preferred_strategy TEXT, direct_rules TEXT, proxy_rules TEXT, updated_at TEXT NOT NULL
    );
  `);
  const runner = createSqliteRunner(database);

  await assert.rejects(() => applyWorkerMigrations(runner), /schema\.sql/);
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'traffic_reports'")
      .get().count,
    0
  );
});

test('migration runner rejects critical primary-key and unique-constraint drift before writing', async () => {
  const cases = [
    {
      name: 'users primary key',
      setup: `
        DROP TABLE users;
        CREATE TABLE users (
          id TEXT NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL, created_at TEXT NOT NULL
        );
      `,
      expected: /users primary key \(\) expected \(id\)/
    },
    {
      name: 'users normalized_name unique constraint',
      setup: `
        DROP TABLE users;
        CREATE TABLE users (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL
        );
      `,
      expected: /users missing unique \(normalized_name\)/
    },
    {
      name: 'devices primary key',
      setup: `
        DROP TABLE devices;
        CREATE TABLE devices (
          id TEXT NOT NULL, user_id TEXT NOT NULL, device_seed TEXT NOT NULL UNIQUE, device_name TEXT, platform TEXT,
          app_version TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
        );
        CREATE INDEX idx_devices_user_id ON devices(user_id);
      `,
      expected: /devices primary key \(\) expected \(id\)/
    },
    {
      name: 'devices device_seed unique constraint',
      setup: `
        DROP TABLE devices;
        CREATE TABLE devices (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_seed TEXT NOT NULL, device_name TEXT, platform TEXT,
          app_version TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
        );
        CREATE INDEX idx_devices_user_id ON devices(user_id);
      `,
      expected: /devices missing unique \(device_seed\)/
    },
    {
      name: 'traffic_daily composite primary key',
      setup: `
        DROP TABLE traffic_daily;
        CREATE TABLE traffic_daily (
          user_id TEXT NOT NULL, device_id TEXT NOT NULL, date TEXT NOT NULL, upload_bytes INTEGER NOT NULL,
          download_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_traffic_daily_user_date ON traffic_daily(user_id, date);
      `,
      expected: /traffic_daily primary key \(\) expected \(user_id,device_id,date\)/
    },
    {
      name: 'traffic_reports primary key',
      setup: `
        DROP TABLE traffic_reports;
        CREATE TABLE traffic_reports (
          id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL, upload_delta INTEGER NOT NULL,
          download_delta INTEGER NOT NULL, reported_at TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX idx_traffic_reports_user_created ON traffic_reports(user_id, created_at);
        CREATE INDEX idx_traffic_reports_created_at ON traffic_reports(created_at);
      `,
      expected: /traffic_reports primary key \(\) expected \(id\)/
    },
    {
      name: 'traffic_report_dedup primary key',
      setup: `
        DROP TABLE traffic_report_dedup;
        CREATE TABLE traffic_report_dedup (
          id TEXT NOT NULL, payload_hash TEXT, traffic_date TEXT NOT NULL, anomaly INTEGER NOT NULL,
          legacy_device_id TEXT, legacy_upload_delta INTEGER, legacy_download_delta INTEGER,
          legacy_reported_at TEXT
        );
      `,
      expected: /traffic_report_dedup primary key \(\) expected \(id\)/
    },
    {
      name: 'rate_limits primary key',
      setup: `
        DROP TABLE rate_limits;
        CREATE TABLE rate_limits (key TEXT NOT NULL, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX idx_rate_limits_reset_at ON rate_limits(reset_at);
      `,
      expected: /rate_limits primary key \(\) expected \(key\)/
    },
    {
      name: 'remote_config primary key',
      setup: `
        DROP TABLE remote_config;
        CREATE TABLE remote_config (
          id INTEGER NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL, subscription_url TEXT,
          rule_profile TEXT, preferred_node TEXT, preferred_strategy TEXT, direct_rules TEXT NOT NULL,
          proxy_rules TEXT NOT NULL, anomaly_threshold_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL
        );
      `,
      expected: /remote_config primary key \(\) expected \(id\)/
    },
    {
      name: 'user_remote_config primary key',
      setup: `
        DROP TABLE user_remote_config;
        CREATE TABLE user_remote_config (
          user_id TEXT NOT NULL, enabled INTEGER, subscription_url TEXT, rule_profile TEXT, preferred_node TEXT,
          preferred_strategy TEXT, direct_rules TEXT, proxy_rules TEXT, updated_at TEXT NOT NULL
        );
      `,
      expected: /user_remote_config primary key \(\) expected \(user_id\)/
    },
    {
      name: 'traffic_anomalies primary key',
      setup: `
        DROP TABLE traffic_anomalies;
        CREATE TABLE traffic_anomalies (
          id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL, date TEXT NOT NULL,
          upload_delta INTEGER NOT NULL, download_delta INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX idx_traffic_anomalies_user_created ON traffic_anomalies(user_id, created_at);
      `,
      expected: /traffic_anomalies primary key \(\) expected \(id\)/
    }
  ];

  for (const item of cases) {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(currentSchema);
      database.exec(item.setup);
      const runner = createSqliteRunner(database);

      await assert.rejects(() => applyWorkerMigrations(runner), item.expected, item.name);
      assert.equal(runner.executedFiles.length, 0, `${item.name} must fail before executing a migration file`);
      assert.equal(runner.alterStatements.length, 0, `${item.name} must fail before altering the schema`);
    } finally {
      database.close();
    }
  }
});

test('migration runner rejects unique, wrong-table, and partial named indexes before writing', async () => {
  const cases = [
    {
      name: 'unique index',
      setup: `
        DROP INDEX idx_traffic_reports_created_at;
        CREATE UNIQUE INDEX idx_traffic_reports_created_at ON traffic_reports(created_at);
      `,
      expected: /idx_traffic_reports_created_at: unique true expected false/
    },
    {
      name: 'wrong-table index',
      setup: `
        DROP INDEX idx_rate_limits_reset_at;
        CREATE TABLE rate_limit_shadow (reset_at INTEGER NOT NULL);
        CREATE INDEX idx_rate_limits_reset_at ON rate_limit_shadow(reset_at);
      `,
      expected: /idx_rate_limits_reset_at: table rate_limit_shadow expected rate_limits/
    },
    {
      name: 'partial index',
      setup: `
        DROP INDEX idx_traffic_reports_created_at;
        CREATE INDEX idx_traffic_reports_created_at ON traffic_reports(created_at)
          WHERE created_at IS NOT NULL;
      `,
      expected: /idx_traffic_reports_created_at: partial true expected false/
    }
  ];

  for (const item of cases) {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(currentSchema);
      database.exec(item.setup);
      const runner = createSqliteRunner(database);

      await assert.rejects(() => applyWorkerMigrations(runner), item.expected, item.name);
      assert.equal(runner.executedFiles.length, 0, `${item.name} must fail before executing a migration file`);
      assert.equal(runner.alterStatements.length, 0, `${item.name} must fail before altering the schema`);
    } finally {
      database.close();
    }
  }
});

function createSqliteRunner(database) {
  const alterStatements = [];
  const executedFiles = [];
  return {
    alterStatements,
    executedFiles,
    async executeFile(path) {
      executedFiles.push(path);
      database.exec(readFileSync(path, 'utf8'));
    },
    async executeSql(sql) {
      if (/^ALTER TABLE/i.test(sql.trim())) alterStatements.push(sql);
      database.exec(sql);
    },
    async getTableInfo(table) {
      const rows = database.prepare(`PRAGMA table_info(${table})`).all();
      return {
        columns: rows.map((row) => row.name),
        primaryKeyColumns: rows
          .filter((row) => Number(row.pk) > 0)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((row) => row.name)
      };
    },
    async getUniqueConstraintColumns(table) {
      return database
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .filter((row) => Number(row.unique) === 1 && Number(row.partial) === 0)
        .map((row) =>
          database
            .prepare(`PRAGMA index_info(${quoteIdentifier(row.name)})`)
            .all()
            .sort((left, right) => Number(left.seqno) - Number(right.seqno))
            .map((column) => column.name)
        )
        .filter((columns) => columns.length > 0);
    },
    async getIndexInfo(index) {
      const owner = database
        .prepare("SELECT tbl_name AS tableName FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(index);
      if (!owner || typeof owner.tableName !== 'string') return null;

      const columns = database
        .prepare(`PRAGMA index_info(${quoteIdentifier(index)})`)
        .all()
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((row) => row.name);
      const metadata = database
        .prepare(`PRAGMA index_list(${quoteIdentifier(owner.tableName)})`)
        .all()
        .find((row) => row.name === index);

      return {
        tableName: owner.tableName,
        columns,
        unique: metadata ? Number(metadata.unique) === 1 : null,
        partial: metadata ? Number(metadata.partial) === 1 : null
      };
    }
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
