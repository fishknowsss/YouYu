import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect as connectSocket, type Server as NetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createTlsServer, getCACertificates, setDefaultCACertificates } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrafficReporter } from '../../src/main/traffic/reporter';
import { TrafficStore } from '../../src/main/traffic/store';

let dir: string;
let server: Server | undefined;
const defaultFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'youyu-traffic-reporter-'));
});

afterEach(async () => {
  globalThis.fetch = defaultFetch;
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(dir, { recursive: true, force: true });
});

async function rejectDirectFetch(): Promise<Response> {
  throw new TypeError('direct route unavailable');
}

function toTrafficDateKey(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function activationPayload(userId: string, deviceId: string, name: string) {
  return {
    userId,
    deviceId,
    name,
    traffic: {
      totalUpload: 0,
      totalDownload: 0,
      todayUpload: 0,
      todayDownload: 0,
      date: toTrafficDateKey(new Date())
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('TrafficReporter', () => {
  it.each([
    ['non-HTTPS', 'http://traffic.example.com'],
    ['credentials', 'https://user:pass@traffic.example.com'],
    ['malformed', 'not a url']
  ])('rejects a %s runtime endpoint before any network request', async (_label, endpoint) => {
    const fetch = vi.fn();
    const reporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint,
      appVersion: '1.7.7',
      fetch
    });

    await expect(reporter.register({ name: 'Alice', passphrase: 'secret' })).rejects.toThrow(
      'traffic endpoint invalid'
    );
    expect(fetch).not.toHaveBeenCalled();
  });

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
    const endpoint = await startSecureJsonEndpoint(async (body, request) => {
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
        body: activationPayload('user_1', 'device_1', String(body.name))
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

  it('keeps the newest concurrent registration when activation responses finish out of order', async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    const store = new TrafficStore(dir);
    await store.addTraffic(100, 200);
    const reporter = new TrafficReporter({
      store,
      endpoint: 'https://traffic.example.com',
      appVersion: '1.6.9',
      fetch
    });
    const reportPending = vi.spyOn(reporter, 'reportPending').mockResolvedValue();

    const first = reporter.register({ name: 'Alice', passphrase: 'first-secret' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const second = reporter.register({ name: 'Bob', passphrase: 'second-secret' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    secondResponse.resolve(
      new Response(JSON.stringify(activationPayload('shared-user', 'shared-device', 'Bob')), { status: 200 })
    );
    await expect(second).resolves.toMatchObject({
      userId: 'shared-user',
      deviceId: 'shared-device',
      name: 'Bob'
    });
    expect(reportPending).toHaveBeenCalledTimes(1);

    firstResponse.resolve(
      new Response(JSON.stringify(activationPayload('shared-user', 'shared-device', 'Alice')), { status: 200 })
    );
    await expect(first).rejects.toThrow('本次流量登记已被较新的操作取代');
    expect(reportPending).toHaveBeenCalledTimes(1);
    await expect(store.getSnapshot()).resolves.toMatchObject({
      identity: {
        userId: 'shared-user',
        deviceId: 'shared-device',
        name: 'Bob'
      }
    });
  });

  it('includes a stable logical device key in activation when available', async () => {
    const deviceKey = '33333333-3333-4333-8333-333333333333';
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.deviceKey).toBe(deviceKey);
      return new Response(JSON.stringify(activationPayload('user_1', 'device_1', 'Alice')), { status: 200 });
    });
    const reporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint: 'https://traffic.example.com',
      appVersion: '1.6.5',
      fetch,
      getDeviceKey: async () => deviceKey
    });

    await expect(reporter.register({ name: 'Alice', passphrase: 'secret' })).resolves.toMatchObject({
      userId: 'user_1',
      deviceId: 'device_1'
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('continues activation without a logical device key when its provider fails', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty('deviceKey');
      return new Response(JSON.stringify(activationPayload('user_1', 'device_1', 'Alice')), { status: 200 });
    });
    const reporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint: 'https://traffic.example.com',
      appVersion: '1.6.5',
      fetch,
      getDeviceKey: async () => Promise.reject(new Error('registry unavailable'))
    });

    await expect(reporter.register({ name: 'Alice', passphrase: 'secret' })).resolves.toMatchObject({
      userId: 'user_1',
      deviceId: 'device_1'
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses activation totals as the authoritative baseline without a follow-up heartbeat', async () => {
    let reportRequests = 0;
    const endpoint = await startSecureJsonEndpoint(async (_body, request) => {
      if (request.url === '/api/traffic/report') {
        reportRequests += 1;
        return { status: 503, body: { error: 'heartbeat unavailable' } };
      }
      return {
        status: 200,
        body: {
          userId: 'cloud-user',
          deviceId: 'cloud-device',
          name: 'Cloud User',
          traffic: {
            totalUpload: 4096,
            totalDownload: 8192,
            todayUpload: 1024,
            todayDownload: 2048,
            date: toTrafficDateKey(new Date())
          }
        }
      };
    });
    const store = new TrafficStore(dir);
    const reporter = new TrafficReporter({ store, endpoint, appVersion: '1.6.1' });

    await expect(reporter.register({ name: 'Cloud User', passphrase: 'secret' })).resolves.toMatchObject({
      userId: 'cloud-user',
      deviceId: 'cloud-device'
    });
    await expect(store.getSnapshot()).resolves.toMatchObject({
      stats: {
        totalUpload: 4096,
        totalDownload: 8192,
        todayUpload: 1024,
        todayDownload: 2048,
        pendingUpload: 0,
        pendingDownload: 0,
        totalSource: 'server'
      }
    });
    expect(reportRequests).toBe(0);
  });

  it('rejects an incomplete activation baseline before replacing the local identity', async () => {
    const endpoint = await startSecureJsonEndpoint(async () => ({
      status: 200,
      body: { userId: 'new-user', deviceId: 'device', name: 'Bob' }
    }));
    const store = new TrafficStore(dir);
    await store.registerIdentity({ userId: 'old-user', deviceId: 'device', name: 'Alice', deviceName: 'PC' });
    await store.addTraffic(100, 200);
    const before = await store.getSnapshot();
    const reporter = new TrafficReporter({ store, endpoint, appVersion: '1.6.1' });

    await expect(reporter.register({ name: 'Bob', passphrase: 'secret' })).rejects.toThrow(
      'traffic activation response invalid'
    );
    await expect(store.getSnapshot()).resolves.toEqual(before);
  });

  it('uses the injected direct fetch before a configured proxy without changing the activation body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(activationPayload('user_1', 'device_1', 'Alice')), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, traffic: { totalUpload: 0, totalDownload: 0 } }), { status: 200 })
      );
    const store = new TrafficStore(dir);
    const reporter = new TrafficReporter({
      store,
      endpoint: 'https://traffic.example.com',
      appVersion: '1.6.0',
      fetch,
      getProxyUrl: () => 'http://127.0.0.1:1'
    });

    await expect(
      reporter.register({ name: ' Alice ', passphrase: ' secret ' }, { proxyUrl: 'http://127.0.0.1:1' })
    ).resolves.toMatchObject({ userId: 'user_1', deviceId: 'device_1' });

    const activation = fetch.mock.calls[0];
    expect(activation?.[0]).toBe('https://traffic.example.com/api/activate');
    expect(JSON.parse(String(activation?.[1]?.body))).toMatchObject({
      name: 'Alice',
      passphrase: 'secret',
      deviceSeed: expect.any(String),
      appVersion: '1.6.0'
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses the exact activation body and device seed when a retryable direct response falls back', async () => {
    let proxiedBody: Record<string, unknown> | undefined;
    const origin = await startJsonTlsOrigin(async (body, request) => {
      expect(request).toContain('POST /api/activate HTTP/1.1');
      proxiedBody = body;
      return {
        status: 200,
        body: activationPayload('user_1', 'device_1', 'Alice')
      };
    });
    const proxy = await startConnectProxy(origin.port);
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporary' }), { status: 503 }));
    const reporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.6.0',
      fetch
    });

    try {
      await withTestCertificate(() =>
        reporter.register({ name: 'Alice', passphrase: 'secret' }, { proxyUrl: proxy.url })
      );
    } finally {
      await proxy.close();
      await origin.close();
    }

    const directBody = String(fetch.mock.calls[0]?.[1]?.body);
    expect(JSON.parse(directBody)).toEqual(proxiedBody);
    expect(proxiedBody).toMatchObject({
      name: 'Alice',
      passphrase: 'secret',
      deviceSeed: expect.any(String),
      appVersion: '1.6.0'
    });
  });

  it('reports both HTTP route outcomes without exposing the activation request', async () => {
    const origin = await startJsonTlsOrigin(async () => ({
      status: 502,
      body: { error: 'gateway unavailable' }
    }));
    const proxy = await startConnectProxy(origin.port);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 }));
    const reporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.6.0',
      fetch
    });

    let error: unknown;
    try {
      await withTestCertificate(() =>
        reporter.register({ name: 'Sensitive Name', passphrase: 'Sensitive Passphrase' }, { proxyUrl: proxy.url })
      );
    } catch (caught) {
      error = caught;
    } finally {
      await proxy.close();
      await origin.close();
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('direct=HTTP_503');
    expect((error as Error).message).toContain('proxy=HTTP_502');
    expect((error as Error).message).not.toContain('agent1');
    expect((error as Error).message).not.toContain('Sensitive Name');
    expect((error as Error).message).not.toContain('Sensitive Passphrase');
  });

  it('keeps the activation error detail returned by the backend', async () => {
    const endpoint = await startSecureJsonEndpoint(async () => ({
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
    const endpoint = await startSecureJsonEndpoint(
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

  it('rejects a truncated response after HTTPS CONNECT without hanging', async () => {
    const origin = await startTruncatedTlsOrigin();
    const proxy = await startConnectProxy(origin.port);
    const reporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.5.8',
      requestTimeoutMs: 500,
      fetch: rejectDirectFetch
    });

    try {
      await expect(
        within(
          withTestCertificate(() => reporter.register({ name: 'Alice', passphrase: 'secret' }, { proxyUrl: proxy.url }))
        )
      ).rejects.toThrow('traffic response aborted');
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('rejects an oversized traffic response through an HTTPS CONNECT tunnel', async () => {
    const origin = await startTruncatedTlsOrigin(64 * 1024 + 1, '{}');
    const proxy = await startConnectProxy(origin.port);
    const reporter = new TrafficReporter({
      store: new TrafficStore(dir),
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.6.8',
      requestTimeoutMs: 1000,
      fetch: rejectDirectFetch
    });

    try {
      await expect(
        within(
          withTestCertificate(() => reporter.register({ name: 'Alice', passphrase: 'secret' }, { proxyUrl: proxy.url }))
        )
      ).rejects.toThrow('code=RESPONSE_BODY_TOO_LARGE');
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('does not report traffic while the identity is still pending activation', async () => {
    let reportCount = 0;
    const endpoint = await startSecureJsonEndpoint(async () => {
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
    const endpoint = await startSecureJsonEndpoint(async (body, request) => {
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

  it.each([
    ['204 response', () => new Response(null, { status: 204 })],
    ['empty object', () => new Response('{}', { status: 200 })],
    ['negative acknowledgement', () => new Response('{"ok":false}', { status: 200 })],
    ['missing traffic totals', () => new Response('{"ok":true}', { status: 200 })],
    [
      'negative total',
      () => new Response('{"ok":true,"traffic":{"totalUpload":-1,"totalDownload":200}}', { status: 200 })
    ],
    [
      'non-finite total',
      () => new Response('{"ok":true,"traffic":{"totalUpload":1e999,"totalDownload":200}}', { status: 200 })
    ]
  ])('keeps pending traffic when a 2xx report result is an invalid %s', async (_label, createResponse) => {
    const store = new TrafficStore(dir);
    await store.createDeviceSeed();
    await store.registerIdentity({ userId: 'user_1', deviceId: 'device_1', name: 'Alice', deviceName: 'DESKTOP' });
    await store.addTraffic(100, 200);
    const reporter = new TrafficReporter({
      store,
      endpoint: 'https://traffic.example.com',
      appVersion: '1.6.5',
      fetch: vi.fn(async () => createResponse())
    });

    await expect(reporter.reportPending()).rejects.toThrow('traffic report response invalid');

    await expect(store.getSnapshot()).resolves.toMatchObject({
      stats: {
        pendingUpload: 100,
        pendingDownload: 200,
        reportStatus: 'failed'
      }
    });
  });

  it('rejects an oversized direct traffic response before parsing it', async () => {
    const store = new TrafficStore(dir);
    await store.createDeviceSeed();
    await store.registerIdentity({ userId: 'user_1', deviceId: 'device_1', name: 'Alice', deviceName: 'DESKTOP' });
    await store.addTraffic(100, 200);
    const reporter = new TrafficReporter({
      store,
      endpoint: 'https://traffic.example.com',
      appVersion: '1.6.5',
      fetch: vi.fn(
        async () => new Response('{}', { status: 200, headers: { 'content-length': String(64 * 1024 + 1) } })
      )
    });

    await expect(reporter.reportPending()).rejects.toThrow('code=RESPONSE_BODY_TOO_LARGE');
    await expect(store.getSnapshot()).resolves.toMatchObject({
      stats: { pendingUpload: 100, pendingDownload: 200 }
    });
  });

  it('reuses the exact signed report body and report id on proxy fallback', async () => {
    let proxiedBody: Record<string, unknown> | undefined;
    let proxiedSignature: string | undefined;
    let proxiedTimestamp: string | undefined;
    const origin = await startJsonTlsOrigin(async (body, request) => {
      expect(request).toContain('POST /api/traffic/report HTTP/1.1');
      proxiedBody = body;
      proxiedSignature = /^x-youyu-signature:\s*(.+)$/im.exec(request)?.[1]?.trim();
      proxiedTimestamp = /^x-youyu-timestamp:\s*(.+)$/im.exec(request)?.[1]?.trim();
      return {
        status: 200,
        body: { ok: true, traffic: { totalUpload: 100, totalDownload: 200 } }
      };
    });
    const proxy = await startConnectProxy(origin.port);
    const fetch = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: 'temporary' }), { status: 503 })
    );
    const store = new TrafficStore(dir);
    await store.createDeviceSeed();
    await store.registerIdentity({
      userId: 'user_1',
      deviceId: 'device_1',
      name: 'Alice',
      deviceName: 'DESKTOP'
    });
    await store.addTraffic(100, 200);
    const reporter = new TrafficReporter({
      store,
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.6.0',
      fetch,
      getProxyUrl: () => proxy.url
    });

    try {
      await withTestCertificate(() => reporter.reportPending());
    } finally {
      await proxy.close();
      await origin.close();
    }

    const directInit = fetch.mock.calls[0]?.[1];
    const directHeaders = directInit?.headers as Record<string, string>;
    const directBody = String(directInit?.body);
    expect(directBody).toBe(JSON.stringify(proxiedBody));
    expect(proxiedBody?.reportId).toEqual(expect.any(String));
    expect(proxiedBody).toMatchObject({
      userId: 'user_1',
      deviceId: 'device_1',
      uploadDelta: 100,
      downloadDelta: 200
    });
    expect(directHeaders['x-youyu-signature']).toBe(proxiedSignature);
    expect(directHeaders['x-youyu-timestamp']).toBe(proxiedTimestamp);
  });

  it('refreshes backend totals even when no local traffic is pending', async () => {
    let reportCount = 0;
    const endpoint = await startSecureJsonEndpoint(async (body, request) => {
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
    const endpoint = await startSecureJsonEndpoint(async (body) => {
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
    const retryStore = new TrafficStore(dir);
    const retryReporter = new TrafficReporter({
      store: retryStore,
      endpoint,
      appVersion: '1.5.1'
    });
    await retryReporter.reportPending();

    expect(reportIds).toHaveLength(2);
    expect(reportIds[1]).toBe(reportIds[0]);
    await expect(retryStore.getSnapshot()).resolves.toMatchObject({
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
    const endpoint = await startSecureJsonEndpoint(async () => {
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

  it('clears a rejected unknown device while preserving pending traffic', async () => {
    const endpoint = await startSecureJsonEndpoint(async () => ({
      status: 403,
      body: { error: 'unknown device' }
    }));
    const store = new TrafficStore(dir);
    await store.createDeviceSeed();
    await store.registerIdentity({ userId: 'u', deviceId: 'd', name: 'A', deviceName: 'PC' });
    await store.addTraffic(100, 200);
    const onIdentityInvalidated = vi.fn(async () => {
      throw new Error('runtime stop failed');
    });
    const reporter = new TrafficReporter({
      store,
      endpoint,
      appVersion: '1.5.8',
      onIdentityInvalidated
    });

    await expect(reporter.reportPending()).rejects.toThrow('traffic report failed: 403 unknown device');
    expect(onIdentityInvalidated).toHaveBeenCalledOnce();
    await expect(store.getSnapshot()).resolves.toMatchObject({
      identity: undefined,
      stats: {
        pendingUpload: 100,
        pendingDownload: 200,
        reportStatus: 'failed',
        reportError: 'traffic report failed: 403 unknown device (route=direct status=403)'
      }
    });
  });

  it('keeps identity for other authorization failures', async () => {
    const endpoint = await startSecureJsonEndpoint(async () => ({
      status: 403,
      body: { error: 'stale request' }
    }));
    const store = new TrafficStore(dir);
    await store.createDeviceSeed();
    await store.registerIdentity({ userId: 'u', deviceId: 'd', name: 'A', deviceName: 'PC' });
    const reporter = new TrafficReporter({ store, endpoint, appVersion: '1.5.8' });

    await expect(reporter.reportPending()).rejects.toThrow('traffic report failed: 403 stale request');
    await expect(store.getSnapshot()).resolves.toMatchObject({
      identity: { userId: 'u', deviceId: 'd' },
      stats: {
        reportStatus: 'failed',
        reportError: 'traffic report failed: 403 stale request (route=direct status=403)'
      }
    });
  });

  it('does not clear a replacement identity when an old report returns unknown device', async () => {
    let releaseResponse: (() => void) | undefined;
    let markRequestStarted: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const endpoint = await startSecureJsonEndpoint(async () => {
      markRequestStarted?.();
      await responseGate;
      return { status: 403, body: { error: 'unknown device' } };
    });
    const store = new TrafficStore(dir);
    await store.createDeviceSeed();
    await store.registerIdentity({ userId: 'old-user', deviceId: 'old-device', name: 'A', deviceName: 'PC' });
    await store.addTraffic(100, 200);
    const onIdentityInvalidated = vi.fn(async () => undefined);
    const reporter = new TrafficReporter({
      store,
      endpoint,
      appVersion: '1.5.8',
      onIdentityInvalidated
    });

    const reporting = reporter.reportPending();
    await requestStarted;
    await store.registerIdentity({ userId: 'new-user', deviceId: 'new-device', name: 'B', deviceName: 'PC' });
    releaseResponse?.();

    await expect(reporting).rejects.toThrow('traffic report failed: 403 unknown device');
    expect(onIdentityInvalidated).not.toHaveBeenCalled();
    await expect(store.getSnapshot()).resolves.toMatchObject({
      identity: { userId: 'new-user', deviceId: 'new-device' },
      stats: { pendingUpload: 0, pendingDownload: 0, reportStatus: 'idle' }
    });
  });

  it('wires identity invalidation to stop runtime work before broadcasting', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const start = source.indexOf('async function handleTrafficIdentityInvalidated');
    const end = source.indexOf('\nasync function ', start + 1);
    const handler = source.slice(start, end);
    const compactHandler = handler.replace(/\s/g, '');

    expect(start).toBeGreaterThan(-1);
    expect(source).toContain('onIdentityInvalidated: handleTrafficIdentityInvalidated');
    expect(handler).toContain('runtimeIntent.cancel();');
    expect(handler).toContain('trafficTracker.stop();');
    expect(handler).toContain('trafficReporter.stop();');
    expect(handler).toContain('stopNodeHealthMonitor();');
    expect(handler).toContain('appRuntimeCoordinator.stopRecovery();');
    expect(handler).toContain('stopRemoteConfigPolling();');
    expect(
      source.slice(
        source.indexOf('function stopRemoteConfigPolling'),
        source.indexOf('async function applyRemoteSubscription')
      )
    ).toContain('subscriptionCoordinator.stop();');
    expect(compactHandler.indexOf('lifecycle.stop()')).toBeGreaterThan(
      compactHandler.indexOf('runtimeIntent.cancel();')
    );
    expect(compactHandler.indexOf('broadcastSnapshot()')).toBeGreaterThan(compactHandler.indexOf('lifecycle.stop()'));
  });

  it('does not apply an old successful report to a replacement identity', async () => {
    let releaseResponse: (() => void) | undefined;
    let markRequestStarted: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const endpoint = await startSecureJsonEndpoint(async () => {
      markRequestStarted?.();
      await responseGate;
      return {
        status: 200,
        body: { ok: true, traffic: { totalUpload: 9000, totalDownload: 12000 } }
      };
    });
    const store = new TrafficStore(dir);
    await store.createDeviceSeed();
    await store.registerIdentity({ userId: 'old-user', deviceId: 'old-device', name: 'A', deviceName: 'PC' });
    await store.addTraffic(100, 200);
    const reporter = new TrafficReporter({ store, endpoint, appVersion: '1.5.8' });

    const reporting = reporter.reportPending();
    await requestStarted;
    await store.registerIdentity({ userId: 'new-user', deviceId: 'new-device', name: 'B', deviceName: 'PC' });
    releaseResponse?.();
    await reporting;

    await expect(store.getSnapshot()).resolves.toMatchObject({
      identity: { userId: 'new-user', deviceId: 'new-device' },
      stats: {
        pendingUpload: 0,
        pendingDownload: 0,
        totalSource: 'local',
        totalUpload: 0,
        totalDownload: 0
      }
    });
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

async function startSecureJsonEndpoint(
  handler: (body: Record<string, unknown>, request: IncomingMessage) => Promise<{ status: number; body: unknown }>
): Promise<string> {
  const httpEndpoint = await startJsonServer(handler);
  const httpsEndpoint = httpEndpoint.replace(/^http:/, 'https:');
  globalThis.fetch = (input, init) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rewritten = value.startsWith(httpsEndpoint) ? `${httpEndpoint}${value.slice(httpsEndpoint.length)}` : value;
    return defaultFetch(rewritten, init);
  };
  return httpsEndpoint;
}

async function startJsonTlsOrigin(
  handler: (body: Record<string, unknown>, request: string) => Promise<{ status: number; body: unknown }>
) {
  const sockets = new Set<Socket>();
  const tlsServer = createTlsServer({ key: testTlsKey, cert: testTlsCert }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let request = '';
    let handled = false;
    socket.on('data', async (chunk: string) => {
      if (handled) return;
      request += chunk;
      const headerEnd = request.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const declaredLength = Number(/^content-length:\s*(\d+)$/im.exec(request.slice(0, headerEnd))?.[1] ?? '0');
      const bodyText = request.slice(headerEnd + 4);
      if (Buffer.byteLength(bodyText) < declaredLength) return;
      handled = true;
      try {
        const result = await handler(JSON.parse(bodyText || '{}') as Record<string, unknown>, request);
        const responseBody = JSON.stringify(result.body);
        socket.end(
          [
            `HTTP/1.1 ${result.status} Test Response`,
            'Content-Type: application/json; charset=utf-8',
            `Content-Length: ${Buffer.byteLength(responseBody)}`,
            'Connection: close',
            '',
            responseBody
          ].join('\r\n')
        );
      } catch {
        socket.destroy();
      }
    });
  });
  tlsServer.on('tlsClientError', () => undefined);
  const port = await listen(tlsServer);
  return {
    port,
    close: () => closeServer(tlsServer, sockets)
  };
}

async function startTruncatedTlsOrigin(declaredLength = 200, body = '{"userId":"partial"') {
  const sockets = new Set<Socket>();
  const tlsServer = createTlsServer({ key: testTlsKey, cert: testTlsCert }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let request = '';
    socket.on('data', (chunk: string) => {
      request += chunk;
      if (!request.includes('\r\n\r\n')) return;
      socket.removeAllListeners('data');
      socket.end(
        [
          'HTTP/1.1 200 OK',
          'Content-Type: application/json; charset=utf-8',
          `Content-Length: ${declaredLength}`,
          'Connection: close',
          '',
          body
        ].join('\r\n')
      );
    });
  });
  tlsServer.on('tlsClientError', () => undefined);
  const port = await listen(tlsServer);
  return {
    port,
    close: () => closeServer(tlsServer, sockets)
  };
}

async function startConnectProxy(originPort: number) {
  const sockets = new Set<Socket>();
  const proxyServer = createServer();
  proxyServer.on('connect', (_request, clientSocket, head) => {
    const client = clientSocket as Socket;
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => undefined);

    const upstream = connectSocket(originPort, '127.0.0.1');
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  const port = await listen(proxyServer);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(proxyServer, sockets)
  };
}

async function listen(localServer: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    localServer.once('error', reject);
    localServer.listen(0, '127.0.0.1', () => {
      localServer.removeListener('error', reject);
      resolve();
    });
  });
  const address = localServer.address();
  if (!address || typeof address === 'string') throw new Error('local test server address missing');
  return address.port;
}

async function closeServer(localServer: NetServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    localServer.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withTestCertificate<T>(run: () => Promise<T>): Promise<T> {
  const previous = getCACertificates('default');
  setDefaultCACertificates([...previous, testTlsCa]);
  try {
    return await run();
  } finally {
    setDefaultCACertificates(previous);
  }
}

function asTestPem(label: string, body: string): string {
  const lines = body.replace(/\s/g, '').match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join('\n');
}

// Public Node.js fixture material, used only by the loopback TLS server in this test.
const testTlsKey = asTestPem(
  'RSA PRIVATE KEY',
  `
MIIEpAIBAAKCAQEA1FYyCvsg04Jwk9wsQoTtBN+6vVbh3a5Snii3kM1CVtsnM0nz
c1/9M3x6Y2Psylont/c9xwialsbYhtsMYjiPHN1qljr81ZnVgA5YehH5CJYPhO1Q
uiWigwPs2m5oT757rtyc6IATJ7FpevJQl87j8XXkAJhMDbao64e+A7TPlHdLpW//
yMY8aNat62CrvmmnsUq2prnnuqibWtq46weJfAf21Po9Zg3/V0EH0o6PY0Z6eIYk
xXQZdpPpWc6hNi/64buhDIwNiIQKv+8QNjGy6PXDm1VIp+pX6KOfiSkYE/RadsRI
AzorfthAP0uqFHzzXi0lVKplzklpV5cJW/TcawIDAQABAoIBAAvbtHfAhpjJVBgt
15rvaX04MWmZjIugzKRgib/gdq/7FTlcC+iJl85kSUF7tyGl30n62MxgwqFhAX6m
hQ6HMhbelrFFIhGbwbyhEHfgwROlrcAysKt0pprCgVvBhrnNXYLqdyjU3jz9P3LK
TY3s0/YMK2uNFdI+PTjKH+Z9Foqn9NZUnUonEDepGyuRO7fLeccWJPv2L4CR4a/5
ku4VbDgVpvVSVRG3PSVzbmxobnpdpl52og+T7tPx1cLnIknPtVljXPWtZdfekh2E
eAp2KxCCHOKzzG3ItBKsVu0woeqEpy8JcoO6LbgmEoVnZpgmtQClbBgef8+i+oGE
BgW9nmECgYEA8gA63QQuZOUC56N1QXURexN2PogF4wChPaCTFbQSJXvSBkQmbqfL
qRSD8P0t7GOioPrQK6pDwFf4BJB01AvkDf8Z6DxxOJ7cqIC7LOwDupXocWX7Q0Qk
O6cwclBVsrDZK00v60uRRpl/a39GW2dx7IiQDkKQndLh3/0TbMIWHNcCgYEA4J6r
yinZbLpKw2+ezhi4B4GT1bMLoKboJwpZVyNZZCzYR6ZHv+lS7HR/02rcYMZGoYbf
n7OHwF4SrnUS7vPhG4g2ZsOhKQnMvFSQqpGmK1ZTuoKGAevyvtouhK/DgtLWzGvX
9fSahiq/UvfXs/z4M11q9Rv9ztPCmG1cwSEHlo0CgYEAogQNZJK8DMhVnYcNpXke
7uskqtCeQE/Xo06xqkIYNAgloBRYNpUYAGa/vsOBz1UVN/kzDUi8ezVp0oRz8tLT
J5u2WIi+tE2HJTiqF3UbOfvK1sCT64DfUSCpip7GAQ/tFNRkVH8PD9kMOYfILsGe
v+DdsO5Xq5HXrwHb02BNNZkCgYBsl8lt33WiPx5OBfS8pu6xkk+qjPkeHhM2bKZs
nkZlS9j0KsudWGwirN/vkkYg8zrKdK5AQ0dqFRDrDuasZ3N5IA1M+V88u+QjWK7o
B6pSYVXxYZDv9OZSpqC+vUrEQLJf+fNakXrzSk9dCT1bYv2Lt6ox/epix7XYg2bI
Z/OHMQKBgQC2FUGhlndGeugTJaoJ8nhT/0VfRUX/h6sCgSerk5qFr/hNCBV4T022
x0NDR2yLG6MXyqApJpG6rh3QIDElQoQCNlI3/KJ6JfEfmqrLLN2OigTvA5sE4fGU
Dp/ha8OQAx95EwXuaG7LgARduvOIK3x8qi8KsZoUGJcg2ywurUbkWA==`
);

const testTlsCert = asTestPem(
  'CERTIFICATE',
  `
MIID6DCCAtCgAwIBAgIUFH02wcL3Qgben6tfIibXitsApCYwDQYJKoZIhvcNAQEL
BQAwejELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAkNBMQswCQYDVQQHDAJTRjEPMA0G
A1UECgwGSm95ZW50MRAwDgYDVQQLDAdOb2RlLmpzMQwwCgYDVQQDDANjYTExIDAe
BgkqhkiG9w0BCQEWEXJ5QHRpbnljbG91ZHMub3JnMCAXDTIyMDkwMzIxNDAzN1oY
DzIyOTYwNjE3MjE0MDM3WjB9MQswCQYDVQQGEwJVUzELMAkGA1UECAwCQ0ExCzAJ
BgNVBAcMAlNGMQ8wDQYDVQQKDAZKb3llbnQxEDAOBgNVBAsMB05vZGUuanMxDzAN
BgNVBAMMBmFnZW50MTEgMB4GCSqGSIb3DQEJARYRcnlAdGlueWNsb3Vkcy5vcmcw
ggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDUVjIK+yDTgnCT3CxChO0E
37q9VuHdrlKeKLeQzUJW2yczSfNzX/0zfHpjY+zKWie39z3HCJqWxtiG2wxiOI8c
3WqWOvzVmdWADlh6EfkIlg+E7VC6JaKDA+zabmhPvnuu3JzogBMnsWl68lCXzuPx
deQAmEwNtqjrh74DtM+Ud0ulb//Ixjxo1q3rYKu+aaexSramuee6qJta2rjrB4l8
B/bU+j1mDf9XQQfSjo9jRnp4hiTFdBl2k+lZzqE2L/rhu6EMjA2IhAq/7xA2MbLo
9cObVUin6lfoo5+JKRgT9Fp2xEgDOit+2EA/S6oUfPNeLSVUqmXOSWlXlwlb9Nxr
AgMBAAGjYTBfMF0GCCsGAQUFBwEBBFEwTzAjBggrBgEFBQcwAYYXaHR0cDovL29j
c3Aubm9kZWpzLm9yZy8wKAYIKwYBBQUHMAKGHGh0dHA6Ly9jYS5ub2RlanMub3Jn
L2NhLmNlcnQwDQYJKoZIhvcNAQELBQADggEBAMM0mBBjLMt9pYXePtUeNO0VTw9y
FWCM8nAcAO2kRNwkJwcsispNpkcsHZ5o8Xf5mpCotdvziEWG1hyxwU6nAWyNOLcN
G0a0KUfbMO3B6ZYe1GwPDjXaQnv75SkAdxgX5zOzca3xnhITcjUUGjQ0fbDfwFV5
ix8mnzvfXjDONdEznVa7PFcN6QliFUMwR/h8pCRHtE5+a10OSPeJSrGG+FtrGnRW
G1IJUv6oiGF/MvWCr84REVgc1j78xomGANJIu2hN7bnD1nEMON6em8IfnDOUtynV
9wfWTqiQYD5Zifj6WcGa0aAHMuetyFG4lIfMAHmd3gaKpks7j9l26LwRPvI=`
);

const testTlsCa = asTestPem(
  'CERTIFICATE',
  `
MIIDlDCCAnygAwIBAgIUSrFsjf1qfQ0t/KvfnEsOksatAikwDQYJKoZIhvcNAQEL
BQAwejELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAkNBMQswCQYDVQQHDAJTRjEPMA0G
A1UECgwGSm95ZW50MRAwDgYDVQQLDAdOb2RlLmpzMQwwCgYDVQQDDANjYTExIDAe
BgkqhkiG9w0BCQEWEXJ5QHRpbnljbG91ZHMub3JnMCAXDTIyMDkwMzIxNDAzN1oY
DzIyOTYwNjE3MjE0MDM3WjB6MQswCQYDVQQGEwJVUzELMAkGA1UECAwCQ0ExCzAJ
BgNVBAcMAlNGMQ8wDQYDVQQKDAZKb3llbnQxEDAOBgNVBAsMB05vZGUuanMxDDAK
BgNVBAMMA2NhMTEgMB4GCSqGSIb3DQEJARYRcnlAdGlueWNsb3Vkcy5vcmcwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDNvf4OGGep+ak+4DNjbuNgy0S/
AZPxahEFp4gpbcvsi9YLOPZ31qpilQeQf7d27scIZ02Qx1YBAzljxELB8H/ZxuYS
cQK0s+DNP22xhmgwMWznO7TezkHP5ujN2UkbfbUpfUxGFgncXeZf9wR7yFWppeHi
RWNBOgsvY7sTrS12kXjWGjqntF7xcEDHc7h+KyF6ZjVJZJCnP6pJEQ+rUjd51eCZ
Xt4WjowLnQiCS1VKzXiP83a++Ma1BKKkUitTR112/Uwd5eGoiByhmLzb/BhxnHJN
07GXjhlMItZRm/jfbZsx1mwnNOO3tx4r08l+DaqkinIadvazs+1ugCaKQn8xAgMB
AAGjEDAOMAwGA1UdEwQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAFqG0RXURDam
56x5accdg9sY5zEGP5VQhkK3ZDc2NyNNa25rwvrjCpO+e0OSwKAmm4aX6iIf2woY
wF2f9swWYzxn9CG4fDlUA8itwlnHxupeL4fGMTYb72vf31plUXyBySRsTwHwBloc
F7KvAZpYYKN9EMH1S/267By6H2I33BT/Ethv//n8dSfmuCurR1kYRaiOC4PVeyFk
B3sj8TtolrN0y/nToWUhmKiaVFnDx3odQ00yhmxR3t21iB7yDkko6D8Vf2dVC4j/
YYBVprXGlTP/hiYRLDoP20xKOYznx5cvHPJ9p+lVcOZUJsJj/Iy750+2n5UiBmXt
lz88C25ucKA=`
);

async function within<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('traffic reporter test timed out')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
