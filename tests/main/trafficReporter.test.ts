import { createServer, type IncomingMessage, type Server } from 'node:http';
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
    const endpoint = await startJsonServer(async (body, request) => {
      if (request.url === '/api/traffic/report') {
        expect(body.uploadDelta).toBe(0);
        expect(body.downloadDelta).toBe(0);
        return {
          status: 200,
          body: { ok: true, traffic: { totalUpload: 0, totalDownload: 0 } }
        };
      }
      expect(request.url).toBe('/api/activate');
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
    const store = new TrafficStore(dir, {
      secretStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
        decryptString: (value) => value.toString('utf8').replace(/^protected:/, '')
      }
    });
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

  it('signs traffic reports and sends a report id', async () => {
    let reportCount = 0;
    const endpoint = await startJsonServer(async (body, request) => {
      reportCount += 1;
      expect(request.url).toBe('/api/traffic/report');
      expect(request.headers['x-youyu-timestamp']).toEqual(expect.any(String));
      expect(request.headers['x-youyu-signature']).toEqual(expect.any(String));
      expect(body.reportId).toEqual(expect.any(String));
      expect(body.userId).toBe('user_1');
      expect(body.deviceId).toBe('device_1');
      expect(body.uploadDelta).toBe(100);
      expect(body.downloadDelta).toBe(200);
      return {
        status: 200,
        body: {
          ok: true,
          traffic: {
            totalUpload: 600,
            totalDownload: 900
          }
        }
      };
    });
    const store = new TrafficStore(dir);
    const reporter = new TrafficReporter({
      store,
      endpoint,
      appVersion: '0.8.7'
    });

    await store.createDeviceSeed();
    await store.registerIdentity({
      userId: 'user_1',
      deviceId: 'device_1',
      name: 'Alice',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200);
    await reporter.reportPending();

    expect(reportCount).toBe(1);
    await expect(store.getSnapshot()).resolves.toMatchObject({
      stats: {
        pendingUpload: 0,
        pendingDownload: 0,
        totalUpload: 600,
        totalDownload: 900,
        totalSource: 'server',
        reportStatus: 'synced'
      }
    });
  });

  it('refreshes backend totals even when no local traffic is pending', async () => {
    let reportCount = 0;
    const endpoint = await startJsonServer(async (body, request) => {
      reportCount += 1;
      expect(request.url).toBe('/api/traffic/report');
      expect(body.uploadDelta).toBe(0);
      expect(body.downloadDelta).toBe(0);
      return {
        status: 200,
        body: {
          ok: true,
          traffic: {
            totalUpload: 4096,
            totalDownload: 8192
          }
        }
      };
    });
    const store = new TrafficStore(dir);
    const reporter = new TrafficReporter({
      store,
      endpoint,
      appVersion: '0.8.7'
    });

    await store.createDeviceSeed();
    await store.registerIdentity({
      userId: 'user_1',
      deviceId: 'device_1',
      name: 'Alice',
      deviceName: 'DESKTOP'
    });
    await reporter.reportPending();

    expect(reportCount).toBe(1);
    await expect(store.getSnapshot()).resolves.toMatchObject({
      stats: {
        totalUpload: 4096,
        totalDownload: 8192,
        totalSource: 'server'
      }
    });
  });

  it('reuses a persisted report id until the pending traffic is acknowledged', async () => {
    const reportIds: unknown[] = [];
    let attempts = 0;
    const endpoint = await startJsonServer(async (body) => {
      attempts += 1;
      reportIds.push(body.reportId);
      if (attempts === 1) return { status: 500, body: { error: 'response lost' } };
      return {
        status: 200,
        body: { ok: true, traffic: { totalUpload: 100, totalDownload: 200 } }
      };
    });
    const store = new TrafficStore(dir);
    await store.createDeviceSeed();
    await store.registerIdentity({
      userId: 'user_1',
      deviceId: 'device_1',
      name: 'Alice',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200);

    const firstReporter = new TrafficReporter({ store, endpoint, appVersion: '1.5.1' });
    await expect(firstReporter.reportPending()).rejects.toThrow('traffic report failed: 500');
    const retryReporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint,
      appVersion: '1.5.1'
    });
    await retryReporter.reportPending();

    expect(reportIds).toHaveLength(2);
    expect(reportIds[1]).toBe(reportIds[0]);
    await expect(store.getSnapshot()).resolves.toMatchObject({
      stats: { pendingUpload: 0, pendingDownload: 0, reportStatus: 'synced' }
    });
  });

  it('shares one in-flight report between concurrent callers', async () => {
    let reportCount = 0;
    let releaseResponse: (() => void) | undefined;
    let markRequestStarted: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const endpoint = await startJsonServer(async () => {
      reportCount += 1;
      markRequestStarted?.();
      await responseGate;
      return { status: 200, body: { ok: true, traffic: { totalUpload: 10, totalDownload: 20 } } };
    });
    const store = new TrafficStore(dir);
    await store.createDeviceSeed();
    await store.registerIdentity({ userId: 'u', deviceId: 'd', name: 'A', deviceName: 'PC' });
    await store.addTraffic(10, 20);
    const reporter = new TrafficReporter({ store, endpoint, appVersion: '1.5.1' });

    const first = reporter.reportPending();
    const second = reporter.reportPending();
    await requestStarted;
    expect(reportCount).toBe(1);
    releaseResponse?.();
    await Promise.all([first, second]);
    expect(reportCount).toBe(1);
  });
});

async function startJsonServer(
  handler: (body: Record<string, unknown>, request: IncomingMessage) => Promise<{ status: number; body: unknown }>
): Promise<string> {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      const result = await handler(body, request);
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed to start');
  return `http://127.0.0.1:${address.port}`;
}
