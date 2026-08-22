import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HttpError,
  assertOnlyFields,
  json,
  readJsonObjectWithLimit,
  requireEmptyBody,
  withRequestId
} from '../src/http.ts';

test('worker response boundary preserves JSON hardening and request ids', async () => {
  const response = withRequestId(json({ ok: true }, 201), 'request-1');
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-request-id'), 'request-1');
  assert.deepEqual(await response.json(), { ok: true });
});

test('worker validation boundary keeps strict object, media-type, size, field, and empty-body rules', async () => {
  const parsed = await readJsonObjectWithLimit(
    new Request('https://worker.example/api', {
      method: 'POST',
      headers: { 'content-type': 'application/problem+json' },
      body: JSON.stringify({ value: 1 })
    }),
    64
  );
  assert.deepEqual(parsed, { value: 1 });
  await assert.rejects(
    readJsonObjectWithLimit(
      new Request('https://worker.example/api', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}'
      }),
      64
    ),
    { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }
  );
  assert.throws(() => assertOnlyFields({ value: 1, extra: true }, ['value'], 'unsupported field'), {
    status: 400,
    message: 'unsupported field'
  });
  await requireEmptyBody(new Request('https://worker.example/api', { method: 'POST' }));
  await assert.rejects(requireEmptyBody(new Request('https://worker.example/api', { method: 'POST', body: 'x' })), {
    status: 400,
    code: 'UNEXPECTED_REQUEST_BODY'
  });
  assert.equal(new HttpError(404, 'not found').code, 'NOT_FOUND');
  assert.equal(new HttpError(400, 'custom rejection').code, 'REQUEST_REJECTED');
});
