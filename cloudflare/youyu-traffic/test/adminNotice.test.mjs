import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminNoticeBoundary } from '../src/adminNotice.ts';
import { isUuid, sha256Hex } from '../src/auth.ts';

class TestHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const boundary = createAdminNoticeBoundary({
  createHttpError: (status, message) => new TestHttpError(status, message),
  assertOnlyFields(value, fields, message) {
    for (const key of Object.keys(value)) {
      if (!fields.includes(key)) throw new TestHttpError(400, message);
    }
  },
  isUuid,
  randomUuid: () => '99999999-9999-4999-8999-999999999999',
  sha256Hex
});

test('admin notice boundary normalizes targeted and broadcast commands without changing defaults', async () => {
  assert.deepEqual(boundary.parseUpdate({ enabled: true, message: ' hello ', tone: 'warning' }), {
    enabled: true,
    message: 'hello',
    tone: 'warning',
    durationMinutes: 10,
    requestId: '99999999-9999-4999-8999-999999999999'
  });
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const command = boundary.parseBroadcast({
    userIds: [first.toUpperCase(), second, first],
    message: ' maintenance ',
    tone: 'info',
    durationMinutes: 15,
    requestId: '33333333-3333-4333-8333-333333333333'
  });
  assert.deepEqual(command.userIds, [first, second]);
  assert.equal(
    await boundary.hashBatchPayload(command),
    await boundary.hashBatchPayload({ ...command, userIds: [second, first] })
  );
});

test('admin notice boundary keeps strict field, duration, revision, and stable derived-id rules', async () => {
  assert.throws(() => boundary.parseReset({ userIds: [], extra: true }), {
    status: 400,
    message: 'unsupported notice field'
  });
  assert.throws(
    () =>
      boundary.parseUpdate({
        enabled: true,
        message: 'notice',
        tone: 'info',
        durationMinutes: 6
      }),
    { status: 400, message: 'invalid notice duration' }
  );
  assert.throws(() => boundary.parseRevision(0), { status: 400, message: 'invalid notice revision' });
  assert.equal(boundary.normalizeStoredDurationMinutes('bad'), 10);
  assert.equal(
    await boundary.deriveRequestId('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111'),
    await boundary.deriveRequestId('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111')
  );
});
