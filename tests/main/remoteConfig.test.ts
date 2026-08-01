import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect as connectSocket, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, getCACertificates, setDefaultCACertificates, type TLSSocket } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteConfigClient } from '../../src/main/remoteConfig';
import type { TrafficStore } from '../../src/main/traffic/store';

const cachedConfig = {
  version: 3,
  enabled: true,
  preferredStrategy: 'auto',
  directRules: ['DOMAIN-SUFFIX,example.cn'],
  proxyRules: ['DOMAIN-SUFFIX,example.com']
};
const activeCachedConfig = {
  version: 3,
  enabled: true,
  directRules: [],
  proxyRules: []
};

const registeredIdentity = {
  userId: 'user-1',
  deviceId: 'device-1',
  verificationStatus: 'verified' as const
};

function cacheEnvelope(
  config: typeof cachedConfig = cachedConfig,
  identity: Pick<typeof registeredIdentity, 'userId' | 'deviceId'> = registeredIdentity
) {
  return {
    schemaVersion: 1,
    identity: { userId: identity.userId, deviceId: identity.deviceId },
    config
  };
}

function createRegisteredStore(): TrafficStore {
  return {
    getSnapshot: async () => ({
      identity: registeredIdentity
    }),
    getDeviceSecret: async () => 'device-secret'
  } as unknown as TrafficStore;
}

async function rejectDirectFetch(): Promise<Response> {
  throw new TypeError('direct route unavailable');
}

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local test server address missing');
  return address.port;
}

async function closeServer(server: NetServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startTlsOrigin(onRequest: (socket: TLSSocket, request: string) => void) {
  const sockets = new Set<Socket>();
  const server = createTlsServer({ key: testTlsKey, cert: testTlsCert }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let request = '';
    let handled = false;
    socket.on('data', (chunk: string) => {
      request += chunk;
      if (!handled && request.includes('\r\n\r\n')) {
        handled = true;
        onRequest(socket, request);
      }
    });
  });
  server.on('tlsClientError', () => undefined);
  const port = await listen(server);
  return {
    port,
    close: () => closeServer(server, sockets)
  };
}

async function startConnectProxy(originPort?: number, onConnect?: (authority: string) => void) {
  const sockets = new Set<Socket>();
  const server = createHttpServer();
  server.on('connect', (request, clientSocket, head) => {
    const client = clientSocket as Socket;
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    onConnect?.(request.url ?? '');
    if (typeof originPort !== 'number') return;

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
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server, sockets)
  };
}

async function startTruncatedHttpProxy() {
  const sockets = new Set<Socket>();
  const server = createHttpServer((request, response) => {
    request.resume();
    request.once('end', () => {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': '200'
      });
      response.write('{"config":{"version":3');
      setImmediate(() => response.destroy());
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server, sockets)
  };
}

async function startOversizedHttpProxy(declaredLength: number) {
  const sockets = new Set<Socket>();
  const server = createHttpServer((request, response) => {
    request.resume();
    request.once('end', () => {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(declaredLength)
      });
      response.end('{}');
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server, sockets)
  };
}

function writeChunkedJson(socket: TLSSocket, body: unknown): void {
  const json = JSON.stringify(body);
  const chunks = [json.slice(0, 17), json.slice(17, 49), json.slice(49)];
  socket.write(
    [
      'HTTP/1.1 200 OK',
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      ''
    ].join('\r\n')
  );
  for (const chunk of chunks) {
    socket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`);
  }
  socket.end('0\r\n\r\n');
}

async function within<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('local proxy test timed out')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

describe('RemoteConfigClient cache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'youyu-remote-config-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('recovers a valid cached config from the atomic backup', async () => {
    await writeFile(join(dir, 'remote-config.json'), '{"enabled":', 'utf8');
    await writeFile(join(dir, 'remote-config.json.bak'), JSON.stringify(cacheEnvelope()), 'utf8');
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: '',
      appVersion: '1.5.0',
      store: createRegisteredStore()
    });

    await expect(client.getActiveConfig()).resolves.toMatchObject({
      version: 3,
      enabled: true
    });
  });

  it('does not apply a cached config after the registered identity changes', async () => {
    await writeFile(join(dir, 'remote-config.json'), JSON.stringify(cacheEnvelope()), 'utf8');
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: '',
      appVersion: '1.5.8',
      store: {
        getSnapshot: async () => ({
          identity: { userId: 'user-2', deviceId: 'device-2', verificationStatus: 'verified' }
        })
      } as unknown as TrafficStore
    });

    await expect(client.getActiveConfig()).resolves.toBeUndefined();
    await expect(client.sync()).resolves.toEqual({ config: undefined, changed: false });
  });

  it('invalidates an active config snapshot after the identity changes', async () => {
    await writeFile(join(dir, 'remote-config.json'), JSON.stringify(cacheEnvelope()), 'utf8');
    let identity = registeredIdentity;
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: '',
      appVersion: '1.5.8',
      store: {
        getSnapshot: async () => ({ identity })
      } as unknown as TrafficStore
    });
    const snapshot = await client.getActiveConfigSnapshot();

    identity = { userId: 'user-2', deviceId: 'device-2', verificationStatus: 'verified' };

    await expect(client.isActiveConfigSnapshotCurrent(snapshot)).resolves.toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['pending', { ...registeredIdentity, verificationStatus: 'pending' as const }]
  ])('does not apply a cached config when the current identity is %s', async (_label, identity) => {
    await writeFile(join(dir, 'remote-config.json'), JSON.stringify(cacheEnvelope()), 'utf8');
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: '',
      appVersion: '1.5.8',
      store: {
        getSnapshot: async () => ({ identity })
      } as unknown as TrafficStore
    });

    await expect(client.getActiveConfig()).resolves.toBeUndefined();
    await expect(client.sync()).resolves.toEqual({ config: undefined, changed: false });
  });

  it('ignores a legacy cache that has no identity binding', async () => {
    const legacy = JSON.stringify(cachedConfig);
    await writeFile(join(dir, 'remote-config.json'), legacy, 'utf8');
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: '',
      appVersion: '1.5.8',
      store: createRegisteredStore()
    });

    await expect(client.getActiveConfig()).resolves.toBeUndefined();
    await expect(readFile(join(dir, 'remote-config.json'), 'utf8')).resolves.toBe(legacy);
  });

  it('reconciles the identity-bound cache before the main process performs a network sync', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const sync = source.slice(
      source.indexOf('async function performRemoteConfigSync'),
      source.indexOf('async function syncRemoteConfig')
    );

    expect(sync.indexOf('const cachedSnapshot = await remoteConfigClient.getActiveConfigSnapshot()')).toBeLessThan(
      sync.indexOf('remoteConfigClient.sync(')
    );
    expect(sync.indexOf('applyRemoteSubscription(cachedSnapshot.config, cachedSnapshot)')).toBeLessThan(
      sync.indexOf('remoteConfigClient.sync(')
    );
  });

  it('clears a persisted remote subscription when traffic identity ownership changes', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const invalidation = source.slice(
      source.indexOf('async function handleTrafficIdentityInvalidated'),
      source.indexOf('async function stopProxy')
    );
    const registration = source.slice(
      source.indexOf('async function registerTrafficIdentity'),
      source.indexOf('async function cancelProxyStart')
    );

    expect(invalidation).toContain('await applyRemoteSubscription(undefined)');
    expect(registration).toContain('previousIdentity.userId !== nextIdentity.userId');
    expect(registration).toContain('previousIdentity.deviceId !== nextIdentity.deviceId');
    expect(registration).toContain('await applyRemoteSubscription(undefined)');
  });

  it.each([
    ['an empty object', {}],
    [
      'invalid field types',
      {
        version: 4,
        enabled: 'true',
        directRules: ['DOMAIN-SUFFIX,example.cn'],
        proxyRules: []
      }
    ],
    [
      'an invalid optional field',
      {
        version: 4,
        enabled: true,
        preferredNode: 42,
        directRules: [],
        proxyRules: []
      }
    ]
  ])('keeps the valid cache when a successful response contains %s', async (_label, remoteConfig) => {
    await writeFile(join(dir, 'remote-config.json'), JSON.stringify(cacheEnvelope()), 'utf8');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ config: remoteConfig }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.5.8',
      store: createRegisteredStore()
    });

    await expect(client.sync()).rejects.toThrow('remote config response invalid');
    await expect(client.getActiveConfig()).resolves.toEqual(activeCachedConfig);
    await expect(readFile(join(dir, 'remote-config.json'), 'utf8')).resolves.toBe(JSON.stringify(cacheEnvelope()));
  });

  it('accepts a valid config when optional remote fields are omitted', async () => {
    const remoteConfig = {
      version: 4,
      enabled: false,
      directRules: [' DOMAIN-SUFFIX,example.cn '],
      proxyRules: []
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ config: remoteConfig }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.5.8',
      store: createRegisteredStore()
    });

    await expect(client.sync()).resolves.toMatchObject({ config: undefined, changed: true });
    await expect(readFile(join(dir, 'remote-config.json'), 'utf8').then(JSON.parse)).resolves.toEqual({
      schemaVersion: 1,
      identity: { userId: 'user-1', deviceId: 'device-1' },
      config: {
        version: 4,
        enabled: false,
        directRules: [],
        proxyRules: []
      }
    });
  });

  it('synchronizes a corrected profile name and persists the current device notice without restarting config', async () => {
    const syncIdentityProfile = vi.fn(async () => true);
    const store = {
      getSnapshot: async () => ({ identity: registeredIdentity }),
      getDeviceSecret: async () => 'device-secret',
      syncIdentityProfile
    } as unknown as TrafficStore;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          config: activeCachedConfig,
          profile: { userId: 'user-1', name: 'Alice', updatedAt: '2026-08-02T00:00:00.000Z' },
          notice: {
            revision: 2,
            message: '<b>纯文本</b>',
            tone: 'warning',
            expiresAt,
            updatedAt: '2026-08-02T00:01:00.000Z'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.7.0',
      store
    });

    await expect(client.sync()).resolves.toEqual({
      config: activeCachedConfig,
      changed: true,
      profileChanged: true,
      noticeChanged: true
    });
    expect(syncIdentityProfile).toHaveBeenCalledWith({ userId: 'user-1', deviceId: 'device-1' }, { name: 'Alice' });
    await expect(client.getActiveNotice()).resolves.toEqual({
      revision: 2,
      message: '<b>纯文本</b>',
      tone: 'warning',
      expiresAt,
      updatedAt: '2026-08-02T00:01:00.000Z'
    });
  });

  it('rejects a remote profile bound to a different user before changing local identity', async () => {
    const syncIdentityProfile = vi.fn(async () => true);
    const store = {
      getSnapshot: async () => ({ identity: registeredIdentity }),
      getDeviceSecret: async () => 'device-secret',
      syncIdentityProfile
    } as unknown as TrafficStore;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          config: activeCachedConfig,
          profile: { userId: 'user-2', name: 'Mallory', updatedAt: '2026-08-02T00:00:00.000Z' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.7.0',
      store
    });

    await expect(client.sync()).rejects.toThrow('remote config profile invalid');
    expect(syncIdentityProfile).not.toHaveBeenCalled();
  });

  it('acknowledges the current notice with a signed request and hides it only after success', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, revision: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(
        JSON.stringify({
          config: activeCachedConfig,
          notice: {
            revision: 1,
            message: '请确认',
            tone: 'info',
            expiresAt,
            updatedAt: '2026-08-02T00:01:00.000Z'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.7.0',
      store: createRegisteredStore(),
      fetch
    });
    await client.sync();

    await expect(client.acknowledgeNotice(1)).resolves.toBe(true);
    await expect(client.getActiveNotice()).resolves.toBeUndefined();
    const acknowledgement = requests.at(-1);
    expect(acknowledgement?.url).toBe('https://config.example.com/api/notices/acknowledge');
    expect(acknowledgement?.init?.method).toBe('POST');
    expect(acknowledgement?.init?.body).toBe(JSON.stringify({ userId: 'user-1', deviceId: 'device-1', revision: 1 }));
    expect(new Headers(acknowledgement?.init?.headers).get('x-youyu-signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serializes notice acknowledgement behind an in-flight sync so stale config cannot restore it', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    let releaseSecondSync: (() => void) | undefined;
    const secondSyncGate = new Promise<void>((resolve) => {
      releaseSecondSync = resolve;
    });
    let getCount = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, revision: 1 }), { status: 200 });
      }
      getCount += 1;
      if (getCount === 2) await secondSyncGate;
      return new Response(
        JSON.stringify({
          config: activeCachedConfig,
          notice: {
            revision: 1,
            message: '请确认',
            tone: 'info',
            expiresAt,
            updatedAt: '2026-08-02T00:01:00.000Z'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.7.0',
      store: createRegisteredStore(),
      fetch
    });
    await client.sync();

    const syncRun = client.sync();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const acknowledgementRun = client.acknowledgeNotice(1);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    releaseSecondSync?.();

    await expect(syncRun).resolves.toMatchObject({ changed: false });
    await expect(acknowledgementRun).resolves.toBe(true);
    await expect(client.getActiveNotice()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('ignores changes to deprecated remote routing and startup fields', async () => {
    await writeFile(join(dir, 'remote-config.json'), JSON.stringify(cacheEnvelope()), 'utf8');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            version: 3,
            enabled: true,
            preferredNode: 'remote-node',
            preferredStrategy: 'manual',
            directRules: ['DOMAIN-SUFFIX,new-direct.example'],
            proxyRules: ['DOMAIN-SUFFIX,new-proxy.example'],
            anomalyThresholdBytes: 2048
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.6.5',
      store: createRegisteredStore()
    });

    await expect(client.sync()).resolves.toEqual({ config: activeCachedConfig, changed: false });
    await expect(readFile(join(dir, 'remote-config.json'), 'utf8').then(JSON.parse)).resolves.toMatchObject({
      config: activeCachedConfig
    });
  });

  it.each(['smart', 'global'])('maps the legacy remote %s profile to smart rules', async (ruleProfile) => {
    const remoteConfig = {
      version: 5,
      enabled: true,
      ruleProfile,
      directRules: [],
      proxyRules: []
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ config: remoteConfig }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.6.5',
      store: createRegisteredStore()
    });

    await expect(client.sync()).resolves.toMatchObject({
      changed: true,
      config: { ruleProfile: 'ruleset' }
    });
    await expect(readFile(join(dir, 'remote-config.json'), 'utf8').then(JSON.parse)).resolves.toMatchObject({
      config: { ruleProfile: 'ruleset' }
    });
  });

  it('uses the injected direct fetch before a configured proxy', async () => {
    const remoteConfig = {
      version: 6,
      enabled: true,
      directRules: [],
      proxyRules: []
    };
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ config: remoteConfig }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.6.0',
      store: createRegisteredStore(),
      fetch
    });

    await expect(client.sync({ proxyUrl: 'http://127.0.0.1:1' })).resolves.toMatchObject({
      changed: true,
      config: remoteConfig
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects an oversized direct remote-config response before parsing it', async () => {
    const body = JSON.stringify({
      config: { version: 7, enabled: true, directRules: [], proxyRules: [] }
    });
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.6.8',
      store: createRegisteredStore(),
      fetch: vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { 'content-length': String(256 * 1024 + 1) }
          })
      )
    });

    await expect(client.sync()).rejects.toThrow('code=RESPONSE_BODY_TOO_LARGE');
  });

  it('discards a response when the registered identity changes while the request is in flight', async () => {
    await writeFile(join(dir, 'remote-config.json'), JSON.stringify(cacheEnvelope()), 'utf8');
    let identity = { userId: 'user-1', deviceId: 'device-1', verificationStatus: 'verified' as const };
    const getSnapshot = vi.fn(async () => ({ identity }));
    let releaseResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    let fetchStartedResolve: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchStartedResolve?.();
      return response;
    });
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.5.8',
      store: {
        getSnapshot,
        getDeviceSecret: async () => 'device-secret'
      } as unknown as TrafficStore
    });

    const sync = client.sync();
    await fetchStarted;
    identity = { userId: 'user-2', deviceId: 'device-2', verificationStatus: 'verified' };
    releaseResponse?.(
      new Response(
        JSON.stringify({
          config: {
            version: 9,
            enabled: true,
            directRules: [],
            proxyRules: ['DOMAIN-SUFFIX,stale.example.com']
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(sync).resolves.toEqual({ config: undefined, changed: false });
    await expect(client.getActiveConfig()).resolves.toBeUndefined();
    await expect(readFile(join(dir, 'remote-config.json'), 'utf8')).resolves.toBe(JSON.stringify(cacheEnvelope()));
    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });

  it('does not return a config when the identity changes while the cache write commits', async () => {
    let snapshotReads = 0;
    const getSnapshot = vi.fn(async () => ({
      identity:
        ++snapshotReads <= 2
          ? registeredIdentity
          : { userId: 'user-2', deviceId: 'device-2', verificationStatus: 'verified' as const }
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            version: 9,
            enabled: true,
            directRules: [],
            proxyRules: ['DOMAIN-SUFFIX,user-one.example.com']
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.example.com',
      appVersion: '1.5.8',
      store: {
        getSnapshot,
        getDeviceSecret: async () => 'device-secret'
      } as unknown as TrafficStore
    });

    await expect(client.sync()).resolves.toEqual({ config: undefined, changed: false });
    await expect(client.getActiveConfig()).resolves.toBeUndefined();
    await expect(readFile(join(dir, 'remote-config.json'), 'utf8').then(JSON.parse)).resolves.toMatchObject({
      identity: { userId: 'user-1', deviceId: 'device-1' },
      config: { version: 9 }
    });
    expect(getSnapshot).toHaveBeenCalledTimes(4);
  });

  it('reads a chunked HTTPS response through the established CONNECT socket', async () => {
    const remoteConfig = {
      version: 5,
      enabled: true,
      preferredStrategy: 'fallback',
      directRules: [],
      proxyRules: ['DOMAIN-SUFFIX,example.com']
    };
    let requestText = '';
    const authorities: string[] = [];
    const origin = await startTlsOrigin((socket, request) => {
      requestText = request;
      writeChunkedJson(socket, { config: remoteConfig });
    });
    const proxy = await startConnectProxy(origin.port, (authority) => authorities.push(authority));
    const controller = new AbortController();
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.5.8',
      requestTimeoutMs: 1000,
      store: createRegisteredStore(),
      fetch: rejectDirectFetch
    });

    try {
      const result = await withTestCertificate(() => client.sync({ proxyUrl: proxy.url, signal: controller.signal }));

      expect(result.config).toEqual({ version: 5, enabled: true, directRules: [], proxyRules: [] });
      expect(authorities).toEqual([`agent1:${origin.port}`]);
      expect(requestText).toContain('GET /api/config?');
      expect(requestText).toContain('accept-encoding: identity');
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('rejects an oversized remote-config response through an HTTPS CONNECT tunnel', async () => {
    const origin = await startTlsOrigin((socket) => {
      socket.end(
        [
          'HTTP/1.1 200 OK',
          'Content-Type: application/json',
          `Content-Length: ${256 * 1024 + 1}`,
          'Connection: close',
          '',
          '{}'
        ].join('\r\n')
      );
    });
    const proxy = await startConnectProxy(origin.port);
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.6.8',
      requestTimeoutMs: 1000,
      store: createRegisteredStore(),
      fetch: rejectDirectFetch
    });

    try {
      await expect(within(withTestCertificate(() => client.sync({ proxyUrl: proxy.url })))).rejects.toThrow(
        'code=RESPONSE_BODY_TOO_LARGE'
      );
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('does not trust an unknown TLS certificate merely because the request uses the local proxy', async () => {
    const origin = await startTlsOrigin((socket) => {
      writeChunkedJson(socket, {
        config: { version: 5, enabled: true, directRules: [], proxyRules: [] }
      });
    });
    const proxy = await startConnectProxy(origin.port);
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.6.0',
      requestTimeoutMs: 1000,
      store: createRegisteredStore(),
      fetch: rejectDirectFetch
    });

    try {
      await expect(client.sync({ proxyUrl: proxy.url })).rejects.toThrow(
        /route=proxy code=(?:DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/
      );
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('rejects a truncated response from an HTTP proxy without hanging', async () => {
    const proxy = await startTruncatedHttpProxy();
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'http://config.invalid',
      appVersion: '1.5.8',
      requestTimeoutMs: 200,
      store: createRegisteredStore(),
      fetch: rejectDirectFetch
    });

    try {
      await expect(within(client.sync({ proxyUrl: proxy.url }))).rejects.toThrow('remote config response aborted');
    } finally {
      await proxy.close();
    }
  });

  it('rejects an oversized remote-config response received through an HTTP proxy', async () => {
    const proxy = await startOversizedHttpProxy(256 * 1024 + 1);
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'http://config.invalid',
      appVersion: '1.6.8',
      requestTimeoutMs: 1000,
      store: createRegisteredStore(),
      fetch: rejectDirectFetch
    });

    try {
      await expect(client.sync({ proxyUrl: proxy.url })).rejects.toThrow('code=RESPONSE_BODY_TOO_LARGE');
    } finally {
      await proxy.close();
    }
  });

  it('aborts an HTTPS request after the CONNECT tunnel is established', async () => {
    let requestSeenResolve: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => {
      requestSeenResolve = resolve;
    });
    let originClosedResolve: (() => void) | undefined;
    const originClosed = new Promise<void>((resolve) => {
      originClosedResolve = resolve;
    });
    const origin = await startTlsOrigin((socket) => {
      requestSeenResolve?.();
      socket.once('close', () => originClosedResolve?.());
    });
    const proxy = await startConnectProxy(origin.port);
    const controller = new AbortController();
    const abortError = new Error('cancel tunneled config request');
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.5.8',
      requestTimeoutMs: 5000,
      store: createRegisteredStore(),
      fetch: rejectDirectFetch
    });

    try {
      const outcome = withTestCertificate(() => client.sync({ proxyUrl: proxy.url, signal: controller.signal })).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      await within(requestSeen);
      controller.abort(abortError);

      await expect(within(outcome)).resolves.toEqual({ error: abortError });
      await expect(within(originClosed)).resolves.toBeUndefined();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      controller.abort(abortError);
      await proxy.close();
      await origin.close();
    }
  });

  it('times out a stalled HTTPS response after the CONNECT tunnel is established', async () => {
    let originClosedResolve: (() => void) | undefined;
    const originClosed = new Promise<void>((resolve) => {
      originClosedResolve = resolve;
    });
    const origin = await startTlsOrigin((socket) => {
      socket.once('close', () => originClosedResolve?.());
    });
    const proxy = await startConnectProxy(origin.port);
    const controller = new AbortController();
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: `https://agent1:${origin.port}`,
      appVersion: '1.5.8',
      requestTimeoutMs: 50,
      store: createRegisteredStore(),
      fetch: rejectDirectFetch
    });

    try {
      await expect(
        within(withTestCertificate(() => client.sync({ proxyUrl: proxy.url, signal: controller.signal })))
      ).rejects.toThrow('remote config request timed out');
      await expect(within(originClosed)).resolves.toBeUndefined();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('times out and cleans up while waiting for a CONNECT response', async () => {
    const proxy = await startConnectProxy();
    const controller = new AbortController();
    const client = new RemoteConfigClient({
      baseDir: dir,
      endpoint: 'https://config.invalid',
      appVersion: '1.5.8',
      requestTimeoutMs: 50,
      store: createRegisteredStore(),
      fetch: rejectDirectFetch
    });

    try {
      await expect(within(client.sync({ proxyUrl: proxy.url, signal: controller.signal }))).rejects.toThrow(
        /route=proxy code=TIMEOUT/
      );
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  });
});

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
