import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrafficReporter } from '../../src/main/traffic/reporter';
import { TrafficStore } from '../../src/main/traffic/store';

let dir: string;
let server: Server | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'youyu-traffic-reporter-'));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(dir, { recursive: true, force: true });
});

describe('TrafficReporter', () => {
  it('marks traffic reporting as not configured when the endpoint is missing', async () => {
    const store = new TrafficStore(dir);
    const reporter = new TrafficReporter({
      store,
      endpoint: '',
      appVersion: '0.8.6'
    });

    await expect(reporter.register({ name: 'Alice', passphrase: 'secret' })).rejects.toThrow(
      'traffic endpoint not configured'
    );

    const snapshot = await store.getSnapshot();
    expect(snapshot.stats.reportStatus).toBe('not-configured');
  });

  it('registers directly without requiring a running proxy', async () => {
    const endpoint = await startJsonServer(async (body) => {
      expect(body.name).toBe('Alice');
      expect(body.passphrase).toBe('secret');
      expect(body.deviceSeed).toEqual(expect.any(String));
      expect(body.appVersion).toBe('0.8.6');
      return {
        status: 200,
        body: { userId: 'user_1', deviceId: 'device_1', name: body.name }
      };
    });
    const store = new TrafficStore(dir);
    const reporter = new TrafficReporter({
      store,
      endpoint,
      appVersion: '0.8.6'
    });

    const identity = await reporter.register({ name: ' Alice ', passphrase: ' secret ' });

    expect(identity).toMatchObject({
      userId: 'user_1',
      deviceId: 'device_1',
      name: 'Alice'
    });
    await expect(store.getSnapshot()).resolves.toMatchObject({
      identity: {
        userId: 'user_1',
        deviceId: 'device_1',
        name: 'Alice'
      }
    });
  });

  it('keeps the activation error detail returned by the backend', async () => {
    const endpoint = await startJsonServer(async () => ({
      status: 403,
      body: { error: 'invalid passphrase' }
    }));
    const reporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint,
      appVersion: '0.8.6'
    });

    await expect(reporter.register({ name: 'Alice', passphrase: 'wrong' })).rejects.toThrow(
      'traffic activation failed: 403 invalid passphrase'
    );
  });

  it('times out stalled activation requests', async () => {
    const endpoint = await startJsonServer(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: 200, body: { userId: 'u', deviceId: 'd' } }), 200);
        })
    );
    const reporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint,
      appVersion: '0.8.6',
      requestTimeoutMs: 20
    });

    await expect(reporter.register({ name: 'Alice', passphrase: 'secret' })).rejects.toThrow(
      /traffic request timed out|aborted/i
    );
  });

  it('does not report traffic while the identity is still pending activation', async () => {
    let reportCount = 0;
    const endpoint = await startJsonServer(async () => {
      reportCount += 1;
      return {
        status: 403,
        body: { error: 'unknown device' }
      };
    });
    const store = new TrafficStore(dir);
    const reporter = new TrafficReporter({
      store,
      endpoint,
      appVersion: '0.8.7'
    });

    await store.registerPendingIdentity({
      name: 'Alice',
      passphrase: 'secret'
    });
    await store.addTraffic(100, 200);
    await reporter.reportPending();

    expect(reportCount).toBe(0);
    await expect(store.getSnapshot()).resolves.toMatchObject({
      stats: {
        pendingUpload: 100,
        pendingDownload: 200
      }
    });
  });
});

async function startJsonServer(
  handler: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>
): Promise<string> {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      const result = await handler(body);
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed to start');
  return `http://127.0.0.1:${address.port}`;
}
