import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerRouter } from '../src/router.ts';

test('worker router preserves declaration order, methods, exact paths, and regex captures', async () => {
  const calls = [];
  const router = createWorkerRouter(
    [
      {
        method: 'OPTIONS',
        handle: ({ request }) => new Response(null, { status: 204, headers: { 'x-method': request.method } })
      },
      {
        method: 'GET',
        path: '/api/items',
        handle: () => new Response('items')
      },
      {
        path: /^\/api\/items\/([^/]+)$/,
        handle: ({ match, request }) => {
          calls.push(`${request.method}:${match?.[1]}`);
          return new Response(match?.[1]);
        }
      }
    ],
    () => new Response('missing', { status: 404 })
  );

  const options = await router(new Request('https://worker.example/anything', { method: 'OPTIONS' }), {});
  assert.equal(options.status, 204);
  const exact = await router(new Request('https://worker.example/api/items'), {});
  assert.equal(await exact.text(), 'items');
  const captured = await router(new Request('https://worker.example/api/items/node-1', { method: 'PUT' }), {});
  assert.equal(await captured.text(), 'node-1');
  assert.deepEqual(calls, ['PUT:node-1']);
  const methodMismatch = await router(new Request('https://worker.example/api/items', { method: 'POST' }), {});
  assert.equal(methodMismatch.status, 404);
});
