import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.ts';

test('unexpected request failures emit only structured redacted telemetry', async () => {
  const adminToken = 'secret-admin-token';
  const databaseError = 'd1 failed with secret-user and /private/path?token=leaked';
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args);
  let response;
  try {
    response = await worker.fetch(
      new Request('https://worker.example/api/admin/config?private=secret-query', {
        headers: { authorization: `Bearer ${adminToken}` }
      }),
      {
        ADMIN_TOKEN: adminToken,
        REGISTRATION_PASSPHRASE: 'registration-secret',
        DB: createAdminFailureDatabase(databaseError)
      }
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 500);
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(await response.json(), { error: 'internal error', code: 'INTERNAL_ERROR', requestId });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].length, 1);
  const [entry] = errors[0];
  assert.deepEqual(
    {
      event: entry.event,
      requestId: entry.requestId,
      method: entry.method,
      route: entry.route,
      status: entry.status,
      errorCode: entry.errorCode
    },
    {
      event: 'worker_request_error',
      requestId,
      method: 'GET',
      route: '/api/admin/config',
      status: 500,
      errorCode: 'INTERNAL_ERROR'
    }
  );
  assert.ok(Number.isSafeInteger(entry.durationMs) && entry.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(errors), /secret-admin-token|secret-query|secret-user|private\/path|d1 failed/i);
});

test('slow request telemetry uses a route template and never includes query values', async () => {
  const warnings = [];
  const originalConsoleWarn = console.warn;
  const originalDateNow = Date.now;
  let clockReads = 0;
  console.warn = (...args) => warnings.push(args);
  Date.now = () => (clockReads++ === 0 ? 1_000 : 2_500);
  let response;
  try {
    response = await worker.fetch(new Request('https://worker.example/admin/assets/app.js?token=secret-query'), {
      DB: {},
      REGISTRATION_PASSPHRASE: 'unused'
    });
  } finally {
    Date.now = originalDateNow;
    console.warn = originalConsoleWarn;
  }

  assert.equal(response.status, 200);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].length, 1);
  assert.deepEqual(
    {
      event: warnings[0][0].event,
      method: warnings[0][0].method,
      route: warnings[0][0].route,
      status: warnings[0][0].status,
      durationMs: warnings[0][0].durationMs
    },
    {
      event: 'worker_request_slow',
      method: 'GET',
      route: '/admin/assets/app.js',
      status: 200,
      durationMs: 1500
    }
  );
  assert.doesNotMatch(JSON.stringify(warnings), /secret-query|token=/i);
});

test('ordinary rejected requests do not generate noisy telemetry', async () => {
  const errors = [];
  const warnings = [];
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = (...args) => errors.push(args);
  console.warn = (...args) => warnings.push(args);
  try {
    const response = await worker.fetch(new Request('https://worker.example/unmatched?secret=value'), {
      DB: {},
      REGISTRATION_PASSPHRASE: 'unused'
    });
    assert.equal(response.status, 404);
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

function createAdminFailureDatabase(message) {
  return {
    prepare(sql) {
      if (sql.includes('INSERT INTO rate_limits')) {
        return {
          bind() {
            return {
              async first() {
                return { attempts: 1 };
              }
            };
          }
        };
      }
      if (sql.includes('DELETE FROM rate_limits')) {
        return {
          bind() {
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }
      if (sql.includes('SELECT * FROM remote_config')) throw new Error(message);
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
