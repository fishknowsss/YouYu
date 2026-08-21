import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { cleanupExpiredData } from '../src/index.ts';

function createDatabase(
  reportChanges,
  rateLimitChanges = [0],
  nonceChanges = [0],
  dedupCapacity = {
    rowCount: 12,
    estimatedBytes: 2048,
    oldestTrafficDate: '2026-01-01',
    newestTrafficDate: '2026-07-11'
  }
) {
  const calls = [];
  const remainingReportChanges = [...reportChanges];
  const remainingRateLimitChanges = [...rateLimitChanges];
  const remainingNonceChanges = [...nonceChanges];

  return {
    calls,
    prepare(sql) {
      if (sql.includes('FROM traffic_report_dedup')) {
        calls.push({ sql, bindings: [] });
        return {
          async first() {
            return dedupCapacity;
          }
        };
      }
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return {
            async run() {
              if (sql.includes('DELETE FROM traffic_reports')) {
                return { meta: { changes: remainingReportChanges.shift() ?? 0 } };
              }
              if (sql.includes('DELETE FROM rate_limits')) {
                return { meta: { changes: remainingRateLimitChanges.shift() ?? 0 } };
              }
              if (sql.includes('DELETE FROM device_request_nonces')) {
                return { meta: { changes: remainingNonceChanges.shift() ?? 0 } };
              }
              throw new Error(`Unexpected SQL: ${sql}`);
            }
          };
        }
      };
    }
  };
}

test('cleanup removes only old report ids in bounded batches and expired rate limits', async () => {
  const db = createDatabase([500, 120], [7]);
  const now = Date.parse('2026-07-11T00:00:00.000Z');

  const result = await cleanupExpiredData({ DB: db }, now);

  assert.deepEqual(result, {
    cutoff: '2026-04-12T00:00:00.000Z',
    deletedReportRows: 620,
    deletedRateLimitRows: 7,
    deletedNonceRows: 0,
    reportBatchLimitReached: false,
    rateLimitBatchLimitReached: false,
    nonceBatchLimitReached: false,
    dedupCapacity: {
      rowCount: 12,
      estimatedBytes: 2048,
      oldestTrafficDate: '2026-01-01',
      newestTrafficDate: '2026-07-11',
      rowBudget: 5_000_000,
      byteBudget: 1024 * 1024 * 1024,
      overBudget: false
    }
  });
  assert.equal(db.calls.length, 5);
  assert.match(db.calls[0].sql, /SELECT id FROM traffic_reports/);
  assert.match(db.calls[0].sql, /created_at < \?/);
  assert.deepEqual(db.calls[0].bindings, ['2026-04-12T00:00:00.000Z', 500]);
  assert.match(db.calls[2].sql, /SELECT key FROM rate_limits/);
  assert.deepEqual(db.calls[2].bindings, [now, 500]);
  assert.match(db.calls[3].sql, /SELECT device_id, request_id FROM device_request_nonces/);
  assert.deepEqual(db.calls[3].bindings, [new Date(now).toISOString(), 500]);
  assert.match(db.calls[4].sql, /FROM traffic_report_dedup/);
  assert.doesNotMatch(db.calls.map((call) => call.sql).join('\n'), /DELETE FROM traffic_report_dedup/);
});

test('cleanup reports when the configured report batch ceiling is reached', async () => {
  const db = createDatabase([500, 500], [0]);

  const result = await cleanupExpiredData({ DB: db }, Date.parse('2026-07-11T00:00:00.000Z'), 2);

  assert.equal(result.deletedReportRows, 1000);
  assert.equal(result.reportBatchLimitReached, true);
  assert.equal(db.calls.filter((call) => call.sql.includes('traffic_reports')).length, 2);
});

test('cleanup bounds an expired rate-limit backlog too', async () => {
  const db = createDatabase([0], [500, 500]);

  const result = await cleanupExpiredData({ DB: db }, Date.parse('2026-07-11T00:00:00.000Z'), 2);

  assert.equal(result.deletedRateLimitRows, 1000);
  assert.equal(result.rateLimitBatchLimitReached, true);
  assert.equal(db.calls.filter((call) => call.sql.includes('rate_limits')).length, 2);
});

test('cleanup measures permanent dedup capacity and never deletes tombstones', async () => {
  const db = createDatabase([0], [0], [0], {
    rowCount: 5_000_001,
    estimatedBytes: 1024 * 1024 * 1024 + 1,
    oldestTrafficDate: '2025-01-01',
    newestTrafficDate: '2026-07-11'
  });

  const result = await cleanupExpiredData({ DB: db }, Date.parse('2026-07-11T00:00:00.000Z'));

  assert.equal(result.dedupCapacity.overBudget, true);
  assert.equal(result.dedupCapacity.rowCount, 5_000_001);
  assert.equal(result.dedupCapacity.estimatedBytes, 1024 * 1024 * 1024 + 1);
  assert.doesNotMatch(db.calls.map((call) => call.sql).join('\n'), /DELETE FROM traffic_report_dedup/);
});

test('scheduled handler defers cleanup with the scheduled timestamp', async () => {
  const db = createDatabase([0], [2]);
  const scheduledTime = Date.parse('2026-07-11T06:17:00.000Z');
  let deferred;

  worker.scheduled(
    { scheduledTime },
    { DB: db },
    {
      waitUntil(promise) {
        deferred = promise;
      }
    }
  );
  await deferred;

  assert.equal(db.calls.find((call) => call.sql.includes('DELETE FROM rate_limits')).bindings[0], scheduledTime);
  assert.equal(
    db.calls.find((call) => call.sql.includes('DELETE FROM device_request_nonces')).bindings[0],
    new Date(scheduledTime).toISOString()
  );
});

test('scheduled handler warns when permanent dedup capacity exceeds its budget', async () => {
  const db = createDatabase([0], [0], [0], {
    rowCount: 5_000_001,
    estimatedBytes: 1024 * 1024 * 1024 + 1,
    oldestTrafficDate: '2025-01-01',
    newestTrafficDate: '2026-07-11'
  });
  const scheduledTime = Date.parse('2026-07-11T06:17:00.000Z');
  const warnings = [];
  const originalConsoleWarn = console.warn;
  let deferred;
  console.warn = (...args) => warnings.push(args);
  try {
    worker.scheduled(
      { scheduledTime },
      { DB: db },
      {
        waitUntil(promise) {
          deferred = promise;
        }
      }
    );
    await deferred;
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.deepEqual(warnings, [
    [
      {
        event: 'traffic_report_dedup_capacity_warning',
        scheduledTime,
        rowCount: 5_000_001,
        estimatedBytes: 1024 * 1024 * 1024 + 1,
        rowBudget: 5_000_000,
        byteBudget: 1024 * 1024 * 1024
      }
    ]
  ]);
});

test('scheduled cleanup remains failed when D1 maintenance rejects', async () => {
  let deferred;
  const scheduledTime = Date.parse('2026-07-11T06:17:00.000Z');
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    worker.scheduled(
      { scheduledTime },
      {
        DB: {
          prepare() {
            throw new Error('d1 unavailable with secret-token and /private/path?userId=secret-user');
          }
        }
      },
      {
        waitUntil(promise) {
          deferred = promise;
        }
      }
    );

    await assert.rejects(deferred, /d1 unavailable/);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(errors, [
    [
      {
        event: 'retention_cleanup_error',
        scheduledTime,
        errorCode: 'D1_MAINTENANCE_FAILED'
      }
    ]
  ]);
  assert.doesNotMatch(JSON.stringify(errors), /secret-token|secret-user|private\/path|d1 unavailable/i);
});

test('manual maintenance endpoint remains admin-only', async () => {
  const response = await worker.fetch(new Request('https://worker.example/api/admin/maintenance', { method: 'POST' }), {
    DB: {},
    REGISTRATION_PASSPHRASE: 'unchanged'
  });

  assert.equal(response.status, 403);
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(await response.json(), { error: 'admin disabled', code: 'ADMIN_DISABLED', requestId });
});
