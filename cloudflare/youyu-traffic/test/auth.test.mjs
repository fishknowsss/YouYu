import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerAuth, signDeviceRequest } from '../src/auth.ts';

class TestHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createAuth(overrides = {}) {
  const events = [];
  const auth = createWorkerAuth({
    getAdminToken: (env) => env.adminToken,
    getClientIp: () => '203.0.113.8',
    consumeRateLimitAttempt: async (_env, key, limit, windowMs) => events.push(`consume:${key}:${limit}:${windowMs}`),
    clearRateLimit: async (_env, key) => events.push(`clear:${key}`),
    resolveCanonicalUserId: async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    findDeviceSeed: async () => 'device-secret',
    createHttpError: (status, message) => new TestHttpError(status, message),
    getHttpErrorStatus: (error) => (error instanceof TestHttpError ? error.status : undefined),
    now: () => 1_700_000_000_000,
    deviceFailureLimit: 12,
    deviceFailureWindowMs: 300_000,
    ...overrides
  });
  return { auth, events };
}

test('worker admin auth keeps disabled, valid-token bypass, and invalid-token rate-limit behavior', async () => {
  const { auth, events } = createAuth();
  await assert.rejects(auth.requireAdmin(new Request('https://worker.example/admin'), {}), {
    status: 403,
    message: 'admin disabled'
  });
  await auth.requireAdmin(
    new Request('https://worker.example/admin', { headers: { authorization: 'Bearer secret' } }),
    { adminToken: ' secret ' }
  );
  assert.deepEqual(events, []);
  await assert.rejects(
    auth.requireAdmin(new Request('https://worker.example/admin', { headers: { authorization: 'Bearer wrong' } }), {
      adminToken: 'secret'
    }),
    { status: 403, message: 'forbidden' }
  );
  assert.deepEqual(events, ['consume:admin:203.0.113.8:10:900000']);
});

test('worker device auth validates the canonical signature and clears only successful failure reservations', async () => {
  const { auth, events } = createAuth();
  const userId = '11111111-1111-4111-8111-111111111111';
  const deviceId = '22222222-2222-4222-8222-222222222222';
  const timestamp = '1700000000000';
  const url = new URL('https://worker.example/api/config?appVersion=1.7.13');
  const signature = await signDeviceRequest('GET', url, '', 'device-secret', timestamp);
  const request = new Request(url, {
    headers: {
      'x-youyu-timestamp': timestamp,
      'x-youyu-signature': signature
    }
  });

  assert.equal(
    await auth.verifyDeviceRequest(request, {}, userId, deviceId, ''),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  assert.deepEqual(events, [
    `consume:device-auth:203.0.113.8:${deviceId}:12:300000`,
    `clear:device-auth:203.0.113.8:${deviceId}`
  ]);
});
