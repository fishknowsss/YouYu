import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { cleanupExpiredData } from '../src/index.ts';

function createDatabase(reportChanges, rateLimitChanges = [0]) {
  const calls = [];
  const remainingReportChanges = [...reportChanges];
  const remainingRateLimitChanges = [...rateLimitChanges];

  return {
    calls,
    prepare(sql) {
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
    reportBatchLimitReached: false,
    rateLimitBatchLimitReached: false
  });
  assert.equal(db.calls.length, 3);
  assert.match(db.calls[0].sql, /SELECT id FROM traffic_reports/);
  assert.match(db.calls[0].sql, /created_at < \?/);
  assert.deepEqual(db.calls[0].bindings, ['2026-04-12T00:00:00.000Z', 500]);
  assert.match(db.calls[2].sql, /SELECT key FROM rate_limits/);
  assert.deepEqual(db.calls[2].bindings, [now, 500]);
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

  assert.equal(db.calls.at(-1).bindings[0], scheduledTime);
});

test('scheduled cleanup remains failed when D1 maintenance rejects', async () => {
  let deferred;
  worker.scheduled(
    { scheduledTime: Date.now() },
    {
      DB: {
        prepare() {
          throw new Error('d1 unavailable');
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
});

test('manual maintenance endpoint remains admin-only', async () => {
  const response = await worker.fetch(new Request('https://worker.example/api/admin/maintenance', { method: 'POST' }), {
    DB: {},
    REGISTRATION_PASSPHRASE: 'unchanged'
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'admin disabled' });
});
