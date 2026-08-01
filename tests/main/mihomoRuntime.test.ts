import { mkdir, mkdtemp, readFile, readdir, rename as renameOnDisk, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  createMihomoRuntime as createMihomoRuntimeProduction,
  type MihomoRuntimeOptions
} from '../../src/main/mihomo/process';
import { spawnWindowsElevatedProcess } from '../../src/main/platform/elevatedProcess';
import type { AppSettings } from '../../src/main/storage/settings';

let tempDirs: string[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('proxies: []\n', { status: 200 }))
  );
});

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    settingsVersion: 1,
    subscriptionUrl: 'https://example.com/sub',
    localSubscriptionUrl: 'https://example.com/sub',
    controllerSecret: 'local-secret',
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'ruleset',
    selectedNode: '',
    systemProxyEnabled: true,
    dnsEnhanced: true,
    snifferEnabled: true,
    tunEnabled: false,
    strictRouteEnabled: true,
    allowLan: false,
    subscriptionRefreshIntervalHours: 12,
    ...overrides
  };
}

function createSuccessfulValidationProcess() {
  const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn> };
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  queueMicrotask(() => child.emit('exit', 0, null));
  return child as never;
}

function createMihomoRuntime(options: MihomoRuntimeOptions) {
  return createMihomoRuntimeProduction({
    ...options,
    spawnValidationProcess: options.spawnValidationProcess ?? createSuccessfulValidationProcess
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('createMihomoRuntime', () => {
  it('writes config and spawns mihomo with the working directory', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const spawn = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const waitForReady = vi.fn(async () => undefined);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: spawn,
      waitForReady
    });

    await runtime.start();

    const config = await readFile(join(userDataDir, 'mihomo', 'config.yaml'), 'utf8');
    expect(config).toContain('https://example.com/sub');
    expect(config).toContain('local-secret');
    expect(spawn).toHaveBeenCalledWith('C:/YouYu/mihomo.exe', [
      '-d',
      join(userDataDir, 'mihomo'),
      '-f',
      join(userDataDir, 'mihomo', 'config.yaml')
    ]);
    expect(waitForReady).toHaveBeenCalledWith('local-secret');
  });

  it('cancels an oversized subscription response and falls back to the remote provider URL', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    let canceledWith: unknown;
    const yaml = `
proxies:
  - name: oversized-node
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(yaml));
                controller.close();
              },
              cancel(reason) {
                canceledWith = reason;
              }
            }),
            { status: 200, headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }
          )
      )
    );
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false })),
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    const config = await readFile(join(userDataDir, 'mihomo', 'config.yaml'), 'utf8');
    expect(config).toContain('https://example.com/sub');
    expect(config).not.toContain('oversized-node');
    expect(canceledWith).toMatchObject({ code: 'RESPONSE_BODY_TOO_LARGE' });
  });

  it('rejects an HTML subscription response without replacing the last-known-good config or cache', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    let responseText = `
proxies:
  - name: last-known-good-node
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(responseText, { status: 200 }))
    );
    const createRuntime = () =>
      createMihomoRuntime({
        binaryPath: 'C:/YouYu/mihomo.exe',
        userDataDir,
        readSettings: async () => makeSettings(),
        spawnProcess: vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false })),
        waitForReady: vi.fn(async () => undefined)
      });

    await createRuntime().start();
    const configPath = join(userDataDir, 'mihomo', 'config.yaml');
    const cachePath = subscriptionCachePath(userDataDir, 'https://example.com/sub');
    const previousConfig = await readFile(configPath, 'utf8');
    const previousCache = await readFile(cachePath, 'utf8');
    responseText = '<!doctype html><html><body>upstream error</body></html>';

    await createRuntime().start();

    await expect(readFile(configPath, 'utf8')).resolves.toBe(previousConfig);
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(previousCache);
  });

  it('rejects an HTML content type even when its body resembles a usable subscription', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    let nodeName = 'last-known-good-node';
    let contentType = 'text/yaml';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            `proxies:\n  - name: ${nodeName}\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n`,
            { status: 200, headers: { 'content-type': contentType } }
          )
      )
    );
    const createRuntime = () =>
      createMihomoRuntime({
        binaryPath: 'C:/YouYu/mihomo.exe',
        userDataDir,
        readSettings: async () => makeSettings(),
        spawnProcess: vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false })),
        waitForReady: vi.fn(async () => undefined)
      });

    await createRuntime().start();
    const configPath = join(userDataDir, 'mihomo', 'config.yaml');
    const cachePath = subscriptionCachePath(userDataDir, 'https://example.com/sub');
    const previousConfig = await readFile(configPath, 'utf8');
    const previousCache = await readFile(cachePath, 'utf8');
    nodeName = 'must-not-be-accepted';
    contentType = 'text/html; charset=utf-8';

    await createRuntime().start();

    await expect(readFile(configPath, 'utf8')).resolves.toBe(previousConfig);
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(previousCache);
  });

  it('validates a complete temporary config with the same Mihomo binary before promoting it', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'proxies:\n  - name: validated-node\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n'
          )
      )
    );
    const configPath = join(userDataDir, 'mihomo', 'config.yaml');
    const cachePath = subscriptionCachePath(userDataDir, 'https://example.com/sub');
    let candidatePath = '';
    let validationWorkDir = '';
    let candidateText = '';
    let filesIsolatedDuringValidation = false;
    const spawnValidationProcess = vi.fn((_binaryPath: string, args: string[]) => {
      candidatePath = args[args.indexOf('-f') + 1] ?? '';
      validationWorkDir = args[args.indexOf('-d') + 1] ?? '';
      const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn> };
      child.killed = false;
      child.kill = vi.fn(() => {
        child.killed = true;
        return true;
      });
      queueMicrotask(() => {
        void Promise.all([
          readFile(candidatePath, 'utf8'),
          readFile(configPath, 'utf8').then(
            () => false,
            (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
          ),
          readFile(cachePath, 'utf8').then(
            () => false,
            (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
          ),
          readdir(validationWorkDir).then(() => true)
        ]).then(
          ([text, configMissing, cacheMissing, validationDirectoryExists]) => {
            candidateText = text;
            filesIsolatedDuringValidation =
              configMissing &&
              cacheMissing &&
              validationDirectoryExists &&
              validationWorkDir !== join(userDataDir, 'mihomo');
            child.emit('exit', 0, null);
          },
          (error) => child.emit('error', error)
        );
      });
      return child as never;
    });
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnValidationProcess,
      spawnProcess: vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false })),
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    expect(spawnValidationProcess).toHaveBeenCalledWith(
      'C:/YouYu/mihomo.exe',
      expect.arrayContaining(['-t', '-d', validationWorkDir, '-f', candidatePath])
    );
    expect(candidatePath).not.toBe(configPath);
    expect(validationWorkDir).toContain(join(userDataDir, 'mihomo', '.validation-'));
    expect(candidateText).toContain('validated-node');
    expect(candidateText).toContain('mixed-port: 7890');
    expect(candidateText).toContain('secret: local-secret');
    expect(filesIsolatedDuringValidation).toBe(true);
    await expect(readFile(configPath, 'utf8')).resolves.toBe(candidateText);
    await expect(readFile(cachePath, 'utf8')).resolves.toContain('validated-node');
    await expect(readFile(candidatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(validationWorkDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rebuilds current config from the cached subscription when a fetched candidate fails validation', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const workDir = join(userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const cachePath = subscriptionCachePath(userDataDir, 'https://example.com/sub');
    const cachedSubscription =
      'proxies:\n  - name: cached-last-known-good-node\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n';
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, 'stale-config-with-old-ports\n', 'utf8');
    await writeFile(cachePath, cachedSubscription, 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'proxies:\n  - name: must-not-be-promoted\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n'
          )
      )
    );
    const spawnProcess = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const spawnValidationProcess = vi
      .fn()
      .mockImplementationOnce(() => createExitedValidationProcess(1))
      .mockImplementationOnce(() => createExitedValidationProcess(0));
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ controllerSecret: 'current-secret', allowLan: true }),
      getPorts: async () => ({ mixedPort: 7788, controllerPort: 9099, dnsPort: 1054 }),
      spawnValidationProcess,
      spawnProcess,
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    const config = await readFile(configPath, 'utf8');
    expect(config).toContain('cached-last-known-good-node');
    expect(config).not.toContain('must-not-be-promoted');
    expect(config).toContain('mixed-port: 7788');
    expect(config).toContain('external-controller: 127.0.0.1:9099');
    expect(config).toContain('secret: current-secret');
    expect(config).toContain('listen: 127.0.0.1:1054');
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(cachedSubscription);
    expect(spawnValidationProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess).toHaveBeenCalledWith('C:/YouYu/mihomo.exe', ['-d', workDir, '-f', configPath]);
    expect((await readdir(workDir)).filter(isMihomoPromotionTemporaryEntry)).toEqual([]);
  });

  it('rolls back the cache when final config promotion rename fails', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const workDir = join(userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const cachePath = subscriptionCachePath(userDataDir, 'https://example.com/sub');
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, 'last-known-good-config\n', 'utf8');
    await writeFile(cachePath, 'last-known-good-cache\n', 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'proxies:\n  - name: must-be-rolled-back\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n'
          )
      )
    );
    let failedFinalRename = false;
    const renameFile = vi.fn(async (source: string, target: string) => {
      if (target === configPath && !failedFinalRename) {
        failedFinalRename = true;
        throw new Error('injected config rename failure');
      }
      await renameOnDisk(source, target);
    });
    const spawnProcess = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      renameFile,
      spawnProcess,
      waitForReady: vi.fn(async () => undefined)
    });

    await expect(runtime.start()).rejects.toThrow('injected config rename failure');

    await expect(readFile(configPath, 'utf8')).resolves.toBe('last-known-good-config\n');
    await expect(readFile(cachePath, 'utf8')).resolves.toBe('last-known-good-cache\n');
    expect(spawnProcess).not.toHaveBeenCalled();
    expect((await readdir(workDir)).filter(isMihomoPromotionTemporaryEntry)).toEqual([]);
  });

  it('kills a timed-out validator and rebuilds from the cached subscription on current ports', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const workDir = join(userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const cachePath = subscriptionCachePath(userDataDir, 'https://example.com/sub');
    await mkdir(workDir, { recursive: true });
    const cachedSubscription =
      'proxies:\n  - name: timeout-fallback-node\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n';
    await writeFile(configPath, 'stale-config-with-old-ports\n', 'utf8');
    await writeFile(cachePath, cachedSubscription, 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'proxies:\n  - name: validator-times-out\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n'
          )
      )
    );
    const validationChild = createStalledValidationProcess();
    const spawnValidationProcess = vi
      .fn()
      .mockImplementationOnce(() => validationChild.process)
      .mockImplementationOnce(() => createExitedValidationProcess(0));
    const spawnProcess = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ controllerSecret: 'current-secret' }),
      getPorts: async () => ({ mixedPort: 7788, controllerPort: 9099, dnsPort: 1054 }),
      spawnValidationProcess,
      configValidationTimeoutMs: 5,
      spawnProcess,
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    expect(validationChild.kill).toHaveBeenCalledOnce();
    const config = await readFile(configPath, 'utf8');
    expect(config).toContain('timeout-fallback-node');
    expect(config).toContain('mixed-port: 7788');
    expect(config).toContain('external-controller: 127.0.0.1:9099');
    expect(config).toContain('secret: current-secret');
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(cachedSubscription);
    expect(spawnValidationProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect((await readdir(workDir)).filter(isMihomoPromotionTemporaryEntry)).toEqual([]);
  });

  it('aborts validation, kills its process, and leaves the last-known-good files untouched', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const workDir = join(userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const cachePath = subscriptionCachePath(userDataDir, 'https://example.com/sub');
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, 'last-known-good-config\n', 'utf8');
    await writeFile(cachePath, 'last-known-good-cache\n', 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'proxies:\n  - name: aborted-candidate\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n'
          )
      )
    );
    const validationChild = createStalledValidationProcess();
    let validationStartedResolve: (() => void) | undefined;
    const validationStarted = new Promise<void>((resolve) => {
      validationStartedResolve = resolve;
    });
    const spawnProcess = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnValidationProcess: () => {
        validationStartedResolve?.();
        return validationChild.process;
      },
      spawnProcess,
      waitForReady: vi.fn(async () => undefined)
    });
    const controller = new AbortController();
    const abortReason = new Error('test validation abort');

    const start = runtime.start(controller.signal);
    await validationStarted;
    controller.abort(abortReason);

    await expect(start).rejects.toBe(abortReason);
    expect(validationChild.kill).toHaveBeenCalledOnce();
    await expect(readFile(configPath, 'utf8')).resolves.toBe('last-known-good-config\n');
    await expect(readFile(cachePath, 'utf8')).resolves.toBe('last-known-good-cache\n');
    expect(spawnProcess).not.toHaveBeenCalled();
    expect((await readdir(workDir)).filter(isMihomoPromotionTemporaryEntry)).toEqual([]);
  });

  it('rejects a stale remote revision immediately before promotion without changing live files', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const workDir = join(userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const remoteSubscriptionUrl = 'https://identity-a.example/sub';
    const cachePath = subscriptionCachePath(userDataDir, remoteSubscriptionUrl);
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, 'last-known-good-config\n', 'utf8');
    await writeFile(cachePath, 'last-known-good-cache\n', 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'proxies:\n  - name: stale-revision-candidate\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n'
          )
      )
    );
    const snapshot = {
      binding: 'identity-a',
      revision: 'revision-a',
      config: {
        version: 1,
        enabled: true,
        subscriptionUrl: remoteSubscriptionUrl,
        directRules: [],
        proxyRules: []
      }
    };
    const isRemoteConfigSnapshotCurrent = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const spawnProcess = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      readRemoteConfigSnapshot: async () => snapshot,
      isRemoteConfigSnapshotCurrent,
      spawnProcess,
      waitForReady: vi.fn(async () => undefined)
    });

    await expect(runtime.start()).rejects.toThrow('remote config changed during mihomo start');

    expect(isRemoteConfigSnapshotCurrent).toHaveBeenCalledTimes(3);
    await expect(readFile(configPath, 'utf8')).resolves.toBe('last-known-good-config\n');
    await expect(readFile(cachePath, 'utf8')).resolves.toBe('last-known-good-cache\n');
    expect(spawnProcess).not.toHaveBeenCalled();
    expect((await readdir(workDir)).filter(isMihomoPromotionTemporaryEntry)).toEqual([]);
  });

  it('rebuilds a validated current-port provider config when no inline subscription is usable', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const workDir = join(userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const cachePath = subscriptionCachePath(userDataDir, 'https://example.com/sub');
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, 'last-known-good-config\n', 'utf8');
    await writeFile(cachePath, 'last-known-good-cache\n', 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(undefined, { status: 503 }))
    );
    const spawnValidationProcess = vi.fn(() => createExitedValidationProcess(0));
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ controllerSecret: 'current-secret' }),
      getPorts: async () => ({ mixedPort: 7788, controllerPort: 9099, dnsPort: 1054 }),
      spawnValidationProcess,
      spawnProcess: vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false })),
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    expect(spawnValidationProcess).toHaveBeenCalledOnce();
    const config = await readFile(configPath, 'utf8');
    expect(config).toContain('mixed-port: 7788');
    expect(config).toContain('external-controller: 127.0.0.1:9099');
    expect(config).toContain('secret: current-secret');
    expect(config).toContain('url: https://example.com/sub');
    expect(config).not.toContain('last-known-good-config');
    await expect(readFile(cachePath, 'utf8')).resolves.toBe('last-known-good-cache\n');
  });

  it.each([
    ['an empty no-node YAML payload', 'proxies: []\n'],
    ['a proxy-shaped payload without a node type', 'proxies:\n  - name: not-a-real-node\n'],
    [
      'a payload containing forbidden control characters',
      'proxies:\n  - name: control-character-node\u0000\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n'
    ]
  ])('rejects %s and rebuilds from the cached subscription on current ports', async (_label, responseText) => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const workDir = join(userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const cachePath = subscriptionCachePath(userDataDir, 'https://example.com/sub');
    const cachedSubscription =
      'proxies:\n  - name: preflight-fallback-node\n    type: ss\n    server: 127.0.0.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: pass\n';
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, 'stale-config-with-old-ports\n', 'utf8');
    await writeFile(cachePath, cachedSubscription, 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(responseText))
    );
    const spawnValidationProcess = vi.fn(() => createExitedValidationProcess(0));
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ controllerSecret: 'current-secret' }),
      getPorts: async () => ({ mixedPort: 7788, controllerPort: 9099, dnsPort: 1054 }),
      spawnValidationProcess,
      spawnProcess: vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false })),
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    expect(spawnValidationProcess).toHaveBeenCalledOnce();
    const config = await readFile(configPath, 'utf8');
    expect(config).toContain('preflight-fallback-node');
    expect(config).toContain('mixed-port: 7788');
    expect(config).toContain('external-controller: 127.0.0.1:9099');
    expect(config).toContain('secret: current-secret');
    expect(config).not.toContain('not-a-real-node');
    expect(config).not.toContain('control-character-node');
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(cachedSubscription);
  });

  it('falls back to the cached subscription config when the subscription endpoint is unavailable', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    let subscriptionAvailable = true;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://example.com/sub') {
        return subscriptionAvailable
          ? new Response(
              `
proxies:
  - name: cached-node
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
proxy-groups:
  - name: PROXY
    type: url-test
    url: http://www.gstatic.com/generate_204
    proxies:
      - cached-node
rules:
  - MATCH,PROXY
`
            )
          : new Response(undefined, { status: 503 });
      }

      return Response.json({ version: 'test' });
    });
    vi.stubGlobal('fetch', fetch);
    const spawn = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));

    const firstRuntime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: spawn,
      waitForReady: vi.fn(async () => undefined)
    });

    await firstRuntime.start();
    const liveConfig = parse(await readFile(join(userDataDir, 'mihomo', 'config.yaml'), 'utf8'));
    expect(liveConfig['proxy-groups'][0]).toMatchObject({
      name: 'PROXY',
      url: 'https://www.gstatic.com/generate_204',
      'expected-status': 204
    });
    subscriptionAvailable = false;

    const secondRuntime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () =>
        makeSettings({
          controllerSecret: 'current-secret',
          mode: 'global',
          allowLan: true
        }),
      getPorts: async () => ({ mixedPort: 7788, controllerPort: 9099, dnsPort: 1054 }),
      spawnProcess: spawn,
      waitForReady: vi.fn(async () => undefined)
    });

    await secondRuntime.start();

    const config = parse(await readFile(join(userDataDir, 'mihomo', 'config.yaml'), 'utf8'));
    expect(config.proxies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'cached-node' })]));
    expect(config).toMatchObject({
      'mixed-port': 7788,
      'external-controller': '127.0.0.1:9099',
      secret: 'current-secret',
      mode: 'global',
      'allow-lan': true
    });
    expect(config.dns.listen).toBe('127.0.0.1:1054');
    expect(config['proxy-groups'][0]).toMatchObject({
      name: 'PROXY',
      url: 'https://www.gstatic.com/generate_204',
      'expected-status': 204
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/sub',
      expect.objectContaining({ headers: { 'User-Agent': 'Clash Verge/2.3.2' } })
    );
  });

  it('does not reuse cached subscription config after the subscription url changes', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    let subscriptionUrl = 'https://example.com/sub-a';
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://example.com/sub-a') {
        return new Response(`
proxies:
  - name: stale-node-from-a
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
`);
      }
      if (String(url) === 'https://example.com/sub-b') {
        return new Response(undefined, { status: 503 });
      }
      return Response.json({ version: 'test' });
    });
    vi.stubGlobal('fetch', fetch);
    const spawn = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const createRuntime = () =>
      createMihomoRuntime({
        binaryPath: 'C:/YouYu/mihomo.exe',
        userDataDir,
        readSettings: async () => makeSettings({ subscriptionUrl, localSubscriptionUrl: subscriptionUrl }),
        spawnProcess: spawn,
        waitForReady: vi.fn(async () => undefined)
      });

    await createRuntime().start();
    subscriptionUrl = 'https://example.com/sub-b';
    await createRuntime().start();

    const config = await readFile(join(userDataDir, 'mihomo', 'config.yaml'), 'utf8');
    expect(config).toContain('https://example.com/sub-b');
    expect(config).not.toContain('stale-node-from-a');
  });

  it('uses only the current identity remote subscription when one is active', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const fetch = vi.fn(async () => new Response('proxies: []\n'));
    vi.stubGlobal('fetch', fetch);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () =>
        makeSettings({
          subscriptionUrl: 'https://old-user.example.com/sub',
          localSubscriptionUrl: 'https://local.example.com/sub',
          remoteSubscriptionUrl: 'https://old-user.example.com/sub'
        }),
      readRemoteConfig: async () => ({
        version: 2,
        enabled: true,
        subscriptionUrl: 'https://current-user.example.com/sub',
        directRules: [],
        proxyRules: []
      }),
      spawnProcess: vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false })),
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    expect(fetch).toHaveBeenCalledWith(
      'https://current-user.example.com/sub',
      expect.objectContaining({ headers: { 'User-Agent': 'Clash Verge/2.3.2' } })
    );
    expect(fetch).not.toHaveBeenCalledWith('https://old-user.example.com/sub', expect.anything());
  });

  it('falls back to the local subscription when no identity-bound remote config is active', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const fetch = vi.fn(async () => new Response('proxies: []\n'));
    vi.stubGlobal('fetch', fetch);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () =>
        makeSettings({
          subscriptionUrl: 'https://old-user.example.com/sub',
          localSubscriptionUrl: 'https://local.example.com/sub',
          remoteSubscriptionUrl: 'https://old-user.example.com/sub'
        }),
      readRemoteConfig: async () => undefined,
      spawnProcess: vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false })),
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    expect(fetch).toHaveBeenCalledWith(
      'https://local.example.com/sub',
      expect.objectContaining({ headers: { 'User-Agent': 'Clash Verge/2.3.2' } })
    );
    expect(fetch).not.toHaveBeenCalledWith('https://old-user.example.com/sub', expect.anything());
  });

  it('does not write or spawn from a remote config whose identity changes during subscription fetch', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    let currentBinding = 'identity-a';
    let releaseFetch: (() => void) | undefined;
    let fetchStartedResolve: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });
    const fetch = vi.fn(async () => {
      fetchStartedResolve?.();
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return new Response('proxies: []\n');
    });
    vi.stubGlobal('fetch', fetch);
    const spawn = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const snapshot = {
      binding: 'identity-a',
      revision: 'identity-a-config',
      config: {
        version: 1,
        enabled: true,
        subscriptionUrl: 'https://identity-a.example/sub',
        directRules: ['DOMAIN-SUFFIX,identity-a.example'],
        proxyRules: []
      }
    };
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ localSubscriptionUrl: 'https://local.example/sub' }),
      readRemoteConfigSnapshot: async () => snapshot,
      isRemoteConfigSnapshotCurrent: async (candidate) => candidate.binding === currentBinding,
      spawnProcess: spawn,
      waitForReady: vi.fn(async () => undefined)
    });

    const start = runtime.start();
    await fetchStarted;
    currentBinding = 'identity-b';
    releaseFetch?.();

    await expect(start).rejects.toThrow('remote config changed during mihomo start');
    expect(fetch).toHaveBeenCalledWith(
      'https://identity-a.example/sub',
      expect.objectContaining({ headers: { 'User-Agent': 'Clash Verge/2.3.2' } })
    );
    expect(spawn).not.toHaveBeenCalled();
    await expect(readFile(join(userDataDir, 'mihomo', 'config.yaml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('stops the spawned process when the remote config identity changes while waiting for readiness', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    let currentBinding = 'identity-a';
    let releaseReady: (() => void) | undefined;
    let readyStartedResolve: (() => void) | undefined;
    const readyStarted = new Promise<void>((resolve) => {
      readyStartedResolve = resolve;
    });
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      queueMicrotask(() => child.emit('exit', 0, null));
      return true;
    });
    const snapshot = {
      binding: 'identity-a',
      revision: 'identity-a-config',
      config: {
        version: 1,
        enabled: true,
        subscriptionUrl: 'https://identity-a.example/sub',
        directRules: [],
        proxyRules: []
      }
    };
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ localSubscriptionUrl: 'https://local.example/sub' }),
      readRemoteConfigSnapshot: async () => snapshot,
      isRemoteConfigSnapshotCurrent: async (candidate) => candidate.binding === currentBinding,
      spawnProcess: () => child as never,
      waitForReady: async () => {
        readyStartedResolve?.();
        await readyGate;
      }
    });

    const start = runtime.start();
    await readyStarted;
    currentBinding = 'identity-b';
    releaseReady?.();

    await expect(start).rejects.toThrow('remote config changed during mihomo start');
    expect(child.kill).toHaveBeenCalledOnce();
    expect(runtime.isRunning?.()).toBe(false);
  });

  it('waits for mihomo to exit before resolving stop', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      queueMicrotask(() => child.emit('exit'));
      return true;
    });
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: () => child as never,
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();
    await runtime.stop();

    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('reports a failure when mihomo exits after it was ready', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn();
    const onUnexpectedExit = vi.fn();
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: () => child as never,
      waitForReady: vi.fn(async () => undefined),
      onUnexpectedExit
    });

    await runtime.start();
    child.emit('exit', 1, null);

    expect(onUnexpectedExit).toHaveBeenCalledWith('exit code 1');
    expect(runtime.isRunning?.()).toBe(false);
  });

  it('does not report an unexpected exit during a user stop', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    });
    const onUnexpectedExit = vi.fn();
    const logLine = vi.fn();
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: () => child as never,
      waitForReady: vi.fn(async () => undefined),
      onUnexpectedExit,
      logLine
    });

    await runtime.start();
    await runtime.stop();

    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(logLine).not.toHaveBeenCalledWith(expect.stringContaining('mihomo exited after ready'));
    expect(runtime.isRunning?.()).toBe(false);
  });

  it('rejects startup when the mihomo process emits an error before readiness', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn();
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: () => child as never,
      waitForReady: vi.fn(
        () =>
          new Promise<void>(() => {
            child.emit('error', new Error('spawn failed'));
          })
      )
    });

    await expect(runtime.start()).rejects.toThrow('spawn failed');
  });

  it('includes recent mihomo output when startup exits before readiness', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
      stderr: EventEmitter;
    };
    child.killed = false;
    child.kill = vi.fn();
    child.stderr = new EventEmitter();
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: () => child as never,
      waitForReady: vi.fn(
        () =>
          new Promise<void>(() => {
            child.stderr.emit('data', 'listen tcp 127.0.0.1:1053: bind failed\n');
            child.emit('exit', 1, null);
          })
      )
    });

    await expect(runtime.start()).rejects.toThrow('recent mihomo output: listen tcp 127.0.0.1:1053: bind failed');
  });

  it('removes stale geo data files before spawning mihomo', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const workDir = join(userDataDir, 'mihomo');
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, 'Country.mmdb'), 'bad');
    const spawn = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: spawn,
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    await expect(readFile(join(workDir, 'Country.mmdb'), 'utf8')).rejects.toThrow();
  });

  it('selects the auto strategy group when mihomo starts without a saved node', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/version')) {
        return Response.json({ version: 'test' });
      }
      if (path.endsWith('/proxies') && !init?.method) {
        return Response.json({
          proxies: {
            节点选择: {
              now: '自动选择',
              all: ['自动选择', 'DIRECT']
            },
            自动选择: {
              now: 'COMPATIBLE',
              all: ['香港 01', '🇹🇼 台湾 08 家宽', '🇹🇼 台湾 09 家宽']
            },
            '香港 01': {},
            '🇹🇼 台湾 08 家宽': {},
            '🇹🇼 台湾 09 家宽': {}
          }
        });
      }
      if (path.includes('/delay')) {
        return Response.json({ delay: path.includes(encodeURIComponent('🇹🇼 台湾 09 家宽')) ? 88 : 0 });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: () => child as never
    });

    await runtime.start();

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/sub',
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'Clash Verge/2.3.2'
        })
      })
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: '自动选择' })
      })
    );
  });

  it('selects a usable node inside the auto strategy group on startup', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn();
    let selectorNow = 'DIRECT';
    let autoNow = '剩余流量：796.81 GB';
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/version')) {
        return Response.json({ version: 'test' });
      }
      if (path.endsWith('/proxies') && !init?.method) {
        return Response.json({
          proxies: {
            节点选择: {
              now: selectorNow,
              all: ['自动选择', 'DIRECT']
            },
            自动选择: {
              now: autoNow,
              all: ['剩余流量：796.81 GB', '中国联通 订阅地址', '香港 01']
            },
            '剩余流量：796.81 GB': {},
            '中国联通 订阅地址': {},
            '香港 01': {}
          }
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith('/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9')) selectorNow = body.name;
      if (path.endsWith('/proxies/%E8%87%AA%E5%8A%A8%E9%80%89%E6%8B%A9')) autoNow = body.name;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: () => child as never
    });

    await runtime.start();

    expect(selectorNow).toBe('自动选择');
    expect(autoNow).toBe('香港 01');
  });

  it('keeps the local auto strategy ahead of deprecated remote startup preferences', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/version')) {
        return Response.json({ version: 'test' });
      }
      if (path.endsWith('/proxies') && !init?.method) {
        return Response.json({
          proxies: {
            节点选择: {
              now: '自动选择',
              all: ['自动选择', 'DIRECT']
            },
            自动选择: {
              now: 'COMPATIBLE',
              all: ['香港 01', '🇯🇵 日本 08 家宽', '美国 01']
            },
            '香港 01': {},
            '🇯🇵 日本 08 家宽': {},
            '美国 01': {}
          }
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ selectedNode: '美国 01' }),
      readRemoteConfig: async () => ({
        version: 2,
        enabled: true,
        preferredNode: '美国 01',
        preferredStrategy: 'manual',
        directRules: [],
        proxyRules: []
      }),
      spawnProcess: () => child as never
    });

    await runtime.start();

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: '自动选择' })
      })
    );
  });

  it('syncs subscription policy groups to the saved node on startup', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn();
    let autoNow = 'node-hk';
    let fallbackNow = 'node-hk';
    let meslNow = 'Fallback';
    let finalNow = 'MESL';
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path === 'https://example.com/sub') {
        return new Response(undefined, { status: 404 });
      }
      if (path.endsWith('/version')) {
        return Response.json({ version: 'test' });
      }
      if (path.endsWith('/proxies') && !init?.method) {
        return Response.json({
          proxies: {
            Auto: {
              now: autoNow,
              all: ['node-hk', 'node-tw']
            },
            Fallback: {
              now: fallbackNow,
              all: ['node-hk', 'node-tw']
            },
            MESL: {
              now: meslNow,
              all: ['Fallback', 'Auto', 'node-hk', 'node-tw']
            },
            Final: {
              now: finalNow,
              all: ['MESL', 'Fallback', 'Auto', 'node-hk', 'node-tw']
            },
            'node-hk': {},
            'node-tw': {}
          }
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith('/proxies/Auto')) autoNow = body.name;
      if (path.endsWith('/proxies/Fallback')) fallbackNow = body.name;
      if (path.endsWith('/proxies/MESL')) meslNow = body.name;
      if (path.endsWith('/proxies/Final')) finalNow = body.name;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ selectedNode: 'node-tw' }),
      spawnProcess: () => child as never
    });

    await runtime.start();

    expect(autoNow).toBe('node-tw');
    expect(fallbackNow).toBe('node-tw');
    expect(meslNow).toBe('node-tw');
    expect(finalNow).toBe('node-tw');
  });

  it('routes the top selector back through the auto strategy group', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/version')) {
        return Response.json({ version: 'test' });
      }
      if (path.endsWith('/proxies') && !init?.method) {
        return Response.json({
          proxies: {
            节点选择: {
              now: 'DIRECT',
              all: ['自动选择', 'DIRECT']
            },
            自动选择: {
              now: '香港 01',
              all: ['香港 01', '🇯🇵 日本 08 家宽']
            },
            '香港 01': {},
            '🇯🇵 日本 08 家宽': {}
          }
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ selectedNode: '🇯🇵 日本 08 家宽' }),
      spawnProcess: () => child as never
    });

    await runtime.start();

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: '自动选择' })
      })
    );
  });

  it('uses the elevated launcher only when TUN is enabled', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const normalSpawn = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const elevatedSpawn = vi.fn(() => ({ once: vi.fn(), kill: vi.fn(), killed: false }));
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ tunEnabled: true }),
      spawnProcess: normalSpawn,
      spawnElevatedProcess: elevatedSpawn,
      waitForReady: vi.fn(async () => undefined)
    });

    await runtime.start();

    expect(elevatedSpawn).toHaveBeenCalledOnce();
    expect(normalSpawn).not.toHaveBeenCalled();
  });

  it('kills an in-flight mihomo startup when the operation is cancelled', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    });
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: () => child as never,
      waitForReady: vi.fn(() => new Promise<void>(() => undefined))
    });
    const controller = new AbortController();
    const startup = runtime.start(controller.signal);

    await vi.waitFor(() => expect(runtime.isRunning?.()).toBe(true));
    controller.abort(new Error('operation canceled'));

    await expect(startup).rejects.toThrow();
    expect(child.kill).toHaveBeenCalled();
    expect(runtime.isRunning?.()).toBe(false);
  });

  it('does not wait for the shutdown timeout when a pre-connect elevated launch is cancelled', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const launcher = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    launcher.exitCode = null;
    launcher.killed = false;
    launcher.kill = vi.fn(() => {
      launcher.killed = true;
      return true;
    });
    const pipe = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      destroy: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    };
    pipe.destroyed = false;
    pipe.destroy = vi.fn(() => {
      pipe.destroyed = true;
      return pipe;
    });
    pipe.write = vi.fn(() => true);
    const spawnLauncher = vi.fn(() => launcher as never);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ tunEnabled: true }),
      spawnElevatedProcess: (binaryPath, args) =>
        spawnWindowsElevatedProcess(binaryPath, args, {
          resolveUserIdentity: async () => ({ userSid: 'S-1-5-21-1000-2000-3000-1001', sessionId: 3 }),
          spawnLauncher,
          createPipeConnection: () => pipe as never
        }),
      waitForReady: vi.fn(() => new Promise<void>(() => undefined))
    });
    const controller = new AbortController();
    const reason = new Error('operation canceled');
    const startup = runtime.start(controller.signal);
    await vi.waitFor(() => expect(spawnLauncher).toHaveBeenCalledOnce());

    controller.abort(reason);
    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      startup.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error })
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), 500);
      })
    ]);
    if (timeout) clearTimeout(timeout);

    expect(outcome).toEqual({ kind: 'rejected', error: reason });
    expect(launcher.kill).toHaveBeenCalledOnce();
    expect(pipe.destroy).toHaveBeenCalledOnce();
    expect(runtime.isRunning?.()).toBe(false);
  });

  it('waits for a killed startup process to exit before completing cancellation or allowing restart', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-runtime-'));
    tempDirs.push(userDataDir);
    const firstChild = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    firstChild.killed = false;
    firstChild.kill = vi.fn(() => {
      firstChild.killed = true;
      return true;
    });
    const secondChild = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    secondChild.killed = false;
    secondChild.kill = vi.fn();
    const spawnProcess = vi.fn().mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const waitForReady = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockResolvedValue(undefined);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess,
      waitForReady
    });
    const controller = new AbortController();
    const startup = runtime.start(controller.signal);
    let startupSettled = false;
    void startup.then(
      () => {
        startupSettled = true;
      },
      () => {
        startupSettled = true;
      }
    );

    await vi.waitFor(() => expect(runtime.isRunning?.()).toBe(true));
    controller.abort(new Error('operation canceled'));
    await vi.waitFor(() => expect(firstChild.kill).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(startupSettled).toBe(false);
    expect(runtime.isRunning?.()).toBe(true);
    await expect(runtime.start()).rejects.toThrow('previous mihomo process has not exited');
    expect(spawnProcess).toHaveBeenCalledOnce();

    firstChild.emit('exit', null, 'SIGTERM');
    await expect(startup).rejects.toThrow('operation canceled');
    expect(runtime.isRunning?.()).toBe(false);

    await runtime.start();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });
});

function subscriptionCachePath(userDataDir: string, url: string): string {
  const urlHash = createHash('sha256').update(url).digest('hex');
  return join(userDataDir, 'mihomo', `subscription-cache-${urlHash}.yaml`);
}

function createExitedValidationProcess(code: number | null, signal: NodeJS.Signals | null = null) {
  const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn> };
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  queueMicrotask(() => child.emit('exit', code, signal));
  return child as never;
}

function createStalledValidationProcess() {
  const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn> };
  child.killed = false;
  const kill = vi.fn(() => {
    child.killed = true;
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  });
  child.kill = kill;
  return { process: child as never, kill };
}

function isMihomoPromotionTemporaryEntry(name: string): boolean {
  return name.includes('.candidate-') || name.includes('.rollback-') || name.startsWith('.validation-');
}
