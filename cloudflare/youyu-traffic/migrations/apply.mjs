import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(migrationDirectory, '..');
const configPath = resolve(workerDirectory, 'wrangler.toml');
const databaseName = 'youyu_traffic';
const subscriptionTables = ['remote_config', 'user_remote_config'];
const migrationFiles = [
  '2026-07-03-add-remote-subscription-url.sql',
  '2026-07-08-security-and-idempotency.sql',
  '2026-07-11-retention-cleanup.sql'
].map((name) => resolve(migrationDirectory, name));
const requiredTableColumns = {
  users: ['id', 'name', 'normalized_name', 'status', 'created_at'],
  devices: ['id', 'user_id', 'device_seed', 'device_name', 'platform', 'app_version', 'first_seen_at', 'last_seen_at'],
  traffic_daily: ['user_id', 'device_id', 'date', 'upload_bytes', 'download_bytes', 'updated_at'],
  traffic_reports: ['id', 'user_id', 'device_id', 'upload_delta', 'download_delta', 'reported_at', 'created_at'],
  rate_limits: ['key', 'attempts', 'reset_at', 'updated_at'],
  remote_config: [
    'id',
    'version',
    'enabled',
    'subscription_url',
    'rule_profile',
    'preferred_node',
    'preferred_strategy',
    'direct_rules',
    'proxy_rules',
    'anomaly_threshold_bytes',
    'updated_at'
  ],
  user_remote_config: [
    'user_id',
    'enabled',
    'subscription_url',
    'rule_profile',
    'preferred_node',
    'preferred_strategy',
    'direct_rules',
    'proxy_rules',
    'updated_at'
  ],
  traffic_anomalies: ['id', 'user_id', 'device_id', 'date', 'upload_delta', 'download_delta', 'reason', 'created_at']
};
const requiredIndexes = {
  idx_devices_user_id: { table: 'devices', columns: ['user_id'] },
  idx_traffic_daily_user_date: { table: 'traffic_daily', columns: ['user_id', 'date'] },
  idx_traffic_reports_user_created: { table: 'traffic_reports', columns: ['user_id', 'created_at'] },
  idx_traffic_reports_created_at: { table: 'traffic_reports', columns: ['created_at'] },
  idx_rate_limits_reset_at: { table: 'rate_limits', columns: ['reset_at'] },
  idx_traffic_anomalies_user_created: { table: 'traffic_anomalies', columns: ['user_id', 'created_at'] }
};
const requiredPrimaryKeyColumns = {
  users: ['id'],
  devices: ['id'],
  traffic_daily: ['user_id', 'device_id', 'date'],
  traffic_reports: ['id'],
  rate_limits: ['key'],
  remote_config: ['id'],
  user_remote_config: ['user_id'],
  traffic_anomalies: ['id']
};
const requiredUniqueConstraintColumns = {
  users: [['normalized_name']],
  devices: [['device_seed']]
};
const baseTableNames = new Set(['users', 'devices', 'traffic_daily']);
const baseIndexNames = new Set(['idx_devices_user_id', 'idx_traffic_daily_user_date']);

export function parseMigrationArgs(args) {
  const knownArgs = new Set(['--local', '--remote', '--check', '--dry-run', '--apply']);
  const unknown = args.filter((arg) => !knownArgs.has(arg));
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown.join(', ')}`);

  const modes = [args.includes('--local') ? 'local' : null, args.includes('--remote') ? 'remote' : null].filter(
    Boolean
  );
  if (modes.length !== 1) throw new Error('choose exactly one explicit target: --local or --remote');

  const operations = [
    args.includes('--check') ? 'check' : null,
    args.includes('--dry-run') ? 'dry-run' : null,
    args.includes('--apply') ? 'apply' : null
  ].filter(Boolean);
  if (operations.length !== 1) {
    throw new Error('choose exactly one explicit operation: --check, --dry-run, or --apply');
  }

  return { mode: modes[0], operation: operations[0] };
}

export async function planWorkerMigrations(runner) {
  const validation = await inspectSchema(runner, requiredTableColumns, requiredIndexes);
  const subscriptionColumnsToAdd = validation.missingColumns.filter((column) =>
    subscriptionTables.some((table) => column === `${table}.subscription_url`)
  );

  return {
    migrationFiles: [...migrationFiles],
    ...validation,
    subscriptionColumnsToAdd
  };
}

export async function applyWorkerMigrations(runner, options = {}) {
  const onStep = options.onStep ?? (() => undefined);
  const preflight = await planWorkerMigrations(runner);
  assertMigrationPreflight(preflight);

  onStep(`execute ${basename(migrationFiles[0])}`);
  await runner.executeFile(migrationFiles[0]);

  for (const qualifiedColumn of await getMissingSubscriptionColumns(runner)) {
    const [table] = qualifiedColumn.split('.');
    const statement = `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN subscription_url TEXT`;
    onStep(`add ${qualifiedColumn}`);
    await runner.executeSql(statement);
  }

  for (const path of migrationFiles.slice(1)) {
    onStep(`execute ${basename(path)}`);
    await runner.executeFile(path);
  }

  const validation = await planWorkerMigrations(runner);
  if (hasSchemaProblems(validation)) {
    throw new Error(`schema validation failed: ${formatMissingSchema(validation)}`);
  }
  return validation;
}

export function createWranglerRunner(mode, spawn = spawnSync) {
  if (mode !== 'local' && mode !== 'remote') throw new Error('invalid Wrangler target');
  const wranglerBin = resolveWranglerBin();

  const runWrangler = (operationArgs) => {
    const args = [
      wranglerBin,
      'd1',
      'execute',
      databaseName,
      '--config',
      configPath,
      `--${mode}`,
      '--yes',
      '--json',
      ...operationArgs
    ];
    const result = spawn(process.execPath, args, {
      cwd: workerDirectory,
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      throw new Error(`wrangler d1 execute failed${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout;
  };

  return {
    async executeFile(path) {
      runWrangler(['--file', path]);
    },
    async executeSql(sql) {
      runWrangler(['--command', sql]);
    },
    async getTableInfo(table) {
      assertKnownTable(table);
      const rows = parseWranglerRows(runWrangler(['--command', `PRAGMA table_info(${quoteIdentifier(table)})`]));
      return {
        columns: rows.map((row) => row.name).filter((name) => typeof name === 'string'),
        primaryKeyColumns: rows
          .filter((row) => Number(row.pk) > 0 && typeof row.name === 'string')
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((row) => row.name)
      };
    },
    async getUniqueConstraintColumns(table) {
      assertKnownTable(table);
      const indexes = parseWranglerRows(
        runWrangler(['--command', `PRAGMA index_list(${quoteIdentifier(table)})`])
      ).filter((row) => Number(row.unique) === 1 && Number(row.partial) === 0 && typeof row.name === 'string');
      const constraints = [];
      for (const index of indexes) {
        const rows = parseWranglerRows(
          runWrangler(['--command', `PRAGMA index_info(${quoteSqlIdentifier(index.name)})`])
        );
        const columns = rows
          .sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map((row) => row.name)
          .filter((name) => typeof name === 'string');
        if (columns.length > 0) constraints.push(columns);
      }
      return constraints;
    },
    async getIndexInfo(index) {
      assertKnownIndex(index);
      const owners = parseWranglerRows(
        runWrangler([
          '--command',
          `SELECT tbl_name AS tableName FROM sqlite_master WHERE type = 'index' AND name = ${quoteSqlString(index)}`
        ])
      );
      const tableName = owners[0]?.tableName;
      if (typeof tableName !== 'string' || !tableName) return null;

      const rows = parseWranglerRows(runWrangler(['--command', `PRAGMA index_info(${quoteIdentifier(index)})`]));
      const columns = rows
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((row) => row.name)
        .filter((name) => typeof name === 'string');
      const metadata = parseWranglerRows(
        runWrangler(['--command', `PRAGMA index_list(${quoteSqlIdentifier(tableName)})`])
      ).find((row) => row.name === index);

      return {
        tableName,
        columns,
        unique: metadata ? parseSqliteFlag(metadata.unique) : null,
        partial: metadata ? parseSqliteFlag(metadata.partial) : null
      };
    }
  };
}

export async function main(args = process.argv.slice(2)) {
  const { mode, operation } = parseMigrationArgs(args);
  const runner = createWranglerRunner(mode);

  if (operation === 'check') {
    const validation = await planWorkerMigrations(runner);
    assertBaseSchema(validation);
    if (hasSchemaProblems(validation)) {
      throw new Error(`schema check failed: ${formatMissingSchema(validation)}`);
    }
    console.log(`[check] ${mode} schema is current`);
    return;
  }

  if (operation === 'dry-run') {
    const plan = await planWorkerMigrations(runner);
    assertMigrationPreflight(plan);
    console.log(`[dry-run] target: ${mode}`);
    console.log(`- execute ${basename(plan.migrationFiles[0])}`);
    for (const table of plan.missingTables.filter((name) => subscriptionTables.includes(name))) {
      console.log(`- create ${table} with subscription_url`);
    }
    for (const column of plan.subscriptionColumnsToAdd) console.log(`- add ${column}`);
    for (const path of plan.migrationFiles.slice(1)) console.log(`- execute ${basename(path)}`);
    console.log('- validate all required tables, columns, indexes, and key constraints');
    return;
  }

  console.log(`[apply] target: ${mode}`);
  await applyWorkerMigrations(runner, { onStep: (step) => console.log(`- ${step}`) });
  console.log('[apply] schema is current');
}

function resolveWranglerBin() {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('wrangler/package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const binPath = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.wrangler;
  if (typeof binPath !== 'string') throw new Error('cannot resolve Wrangler CLI');
  return resolve(dirname(packagePath), binPath);
}

function parseWranglerRows(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error('Wrangler returned invalid JSON');
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  return envelopes.flatMap((entry) => (Array.isArray(entry?.results) ? entry.results : []));
}

function quoteIdentifier(value) {
  if (!Object.hasOwn(requiredTableColumns, value) && !Object.hasOwn(requiredIndexes, value)) {
    throw new Error(`unsupported identifier: ${value}`);
  }
  return `"${value}"`;
}

function quoteSqlIdentifier(value) {
  if (typeof value !== 'string' || !value) throw new Error('unsupported empty identifier');
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteSqlString(value) {
  if (typeof value !== 'string') throw new Error('unsupported SQL string');
  return `'${value.replaceAll("'", "''")}'`;
}

function parseSqliteFlag(value) {
  const numeric = Number(value);
  if (numeric === 0) return false;
  if (numeric === 1) return true;
  return null;
}

function assertKnownTable(value) {
  if (!Object.hasOwn(requiredTableColumns, value)) throw new Error(`unsupported table: ${value}`);
}

function assertKnownIndex(value) {
  if (!Object.hasOwn(requiredIndexes, value)) throw new Error(`unsupported index: ${value}`);
}

function formatMissingSchema(plan) {
  return [
    ...plan.missingTables.map((table) => `${table} table`),
    ...plan.missingColumns,
    ...plan.missingIndexes.map((index) => `${index} index`),
    ...plan.invalidIndexes,
    ...plan.invalidPrimaryKeys,
    ...plan.missingUniqueConstraints
  ].join(', ');
}

async function inspectSchema(runner, tableColumns, indexes) {
  const missingTables = [];
  const missingColumns = [];
  const missingIndexes = [];
  const invalidIndexes = [];
  const invalidPrimaryKeys = [];
  const missingUniqueConstraints = [];

  for (const [table, expectedColumns] of Object.entries(tableColumns)) {
    const { columns: actualColumns, primaryKeyColumns } = await runner.getTableInfo(table);
    if (actualColumns.length === 0) {
      missingTables.push(table);
      continue;
    }
    for (const column of expectedColumns) {
      if (!actualColumns.includes(column)) missingColumns.push(`${table}.${column}`);
    }

    const expectedPrimaryKey = requiredPrimaryKeyColumns[table];
    if (expectedPrimaryKey && !sameColumns(primaryKeyColumns, expectedPrimaryKey)) {
      invalidPrimaryKeys.push(
        `${table} primary key (${primaryKeyColumns.join(',')}) expected (${expectedPrimaryKey.join(',')})`
      );
    }

    const expectedUniqueConstraints = requiredUniqueConstraintColumns[table] ?? [];
    if (expectedUniqueConstraints.length > 0) {
      const actualUniqueConstraints = await runner.getUniqueConstraintColumns(table);
      for (const expectedConstraint of expectedUniqueConstraints) {
        if (!actualUniqueConstraints.some((actualConstraint) => sameColumns(actualConstraint, expectedConstraint))) {
          missingUniqueConstraints.push(`${table} missing unique (${expectedConstraint.join(',')})`);
        }
      }
    }
  }

  for (const [index, expected] of Object.entries(indexes)) {
    const actual = await runner.getIndexInfo(index);
    if (!actual) {
      missingIndexes.push(index);
      continue;
    }

    const problems = [];
    if (actual.tableName !== expected.table) problems.push(`table ${actual.tableName} expected ${expected.table}`);
    if (!sameColumns(actual.columns, expected.columns)) {
      problems.push(`columns (${actual.columns.join(',')}) expected (${expected.columns.join(',')})`);
    }
    if (actual.unique !== false) problems.push(`unique ${String(actual.unique)} expected false`);
    if (actual.partial !== false) problems.push(`partial ${String(actual.partial)} expected false`);
    if (problems.length > 0) {
      invalidIndexes.push(`${index}: ${problems.join('; ')}`);
    }
  }

  return {
    missingTables,
    missingColumns,
    missingIndexes,
    invalidIndexes,
    invalidPrimaryKeys,
    missingUniqueConstraints
  };
}

async function getMissingSubscriptionColumns(runner) {
  const missing = [];
  for (const table of subscriptionTables) {
    const { columns } = await runner.getTableInfo(table);
    if (columns.length > 0 && !columns.includes('subscription_url')) missing.push(`${table}.subscription_url`);
  }
  return missing;
}

function assertMigrationPreflight(plan) {
  assertBaseSchema(plan);
  const unrepairableColumns = plan.missingColumns.filter((column) => !plan.subscriptionColumnsToAdd.includes(column));
  if (
    unrepairableColumns.length > 0 ||
    plan.invalidIndexes.length > 0 ||
    plan.invalidPrimaryKeys.length > 0 ||
    plan.missingUniqueConstraints.length > 0
  ) {
    throw new Error(
      `schema drift cannot be repaired by these migrations: ${[
        ...unrepairableColumns,
        ...plan.invalidIndexes,
        ...plan.invalidPrimaryKeys,
        ...plan.missingUniqueConstraints
      ].join(', ')}`
    );
  }
}

function assertBaseSchema(plan) {
  const baseProblems = {
    missingTables: plan.missingTables.filter((table) => baseTableNames.has(table)),
    missingColumns: plan.missingColumns.filter((column) => baseTableNames.has(column.split('.')[0])),
    missingIndexes: plan.missingIndexes.filter((index) => baseIndexNames.has(index)),
    invalidIndexes: plan.invalidIndexes.filter((index) => baseIndexNames.has(index.split(':')[0])),
    invalidPrimaryKeys: plan.invalidPrimaryKeys.filter((constraint) => baseTableNames.has(constraint.split(' ')[0])),
    missingUniqueConstraints: plan.missingUniqueConstraints.filter((constraint) =>
      baseTableNames.has(constraint.split(' ')[0])
    )
  };
  if (hasSchemaProblems(baseProblems)) {
    throw new Error(
      `base schema is incomplete: ${formatMissingSchema(baseProblems)}; initialize the database with schema.sql (or repair these base objects) before running migrations`
    );
  }
}

function hasSchemaProblems(plan) {
  return (
    plan.missingTables.length > 0 ||
    plan.missingColumns.length > 0 ||
    plan.missingIndexes.length > 0 ||
    plan.invalidIndexes.length > 0 ||
    plan.invalidPrimaryKeys.length > 0 ||
    plan.missingUniqueConstraints.length > 0
  );
}

function sameColumns(actual, expected) {
  return actual.join('\u0000') === expected.join('\u0000');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
