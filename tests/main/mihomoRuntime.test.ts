import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMihomoRuntime } from '../../src/main/mihomo/process';
import type { AppSettings } from '../../src/main/storage/settings';

let tempDirs: string[] = [];

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    subscriptionUrl: 'https://example.com/sub',
    controllerSecret: 'local-secret',
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'smart',
    defaultNodeKeywords: [],
    systemProxyEnabled: true,
    dnsEnhanced: true,
    snifferEnabled: true,
    tunEnabled: false,
    allowLan: false,
    ...overrides
  };
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
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings(),
      spawnProcess: () => child as never,
      waitForReady: vi.fn(async () => undefined),
      onUnexpectedExit
    });

    await runtime.start();
    await runtime.stop();

    expect(onUnexpectedExit).not.toHaveBeenCalled();
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

    await expect(runtime.start()).rejects.toThrow(
      'recent mihomo output: listen tcp 127.0.0.1:1053: bind failed'
    );
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

  it('prefers the Japanese 09 home node when mihomo starts on COMPATIBLE', async () => {
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
              all: ['香港 01', '🇯🇵 日本 08 家宽', '🇯🇵 日本 09 家宽']
            },
            '香港 01': {},
            '🇯🇵 日本 08 家宽': {},
            '🇯🇵 日本 09 家宽': {}
          }
        });
      }
      if (path.includes('/delay')) {
        return Response.json({ delay: path.includes(encodeURIComponent('🇯🇵 日本 09 家宽')) ? 88 : 0 });
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
      'http://127.0.0.1:9090/proxies/%E8%87%AA%E5%8A%A8%E9%80%89%E6%8B%A9',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: '🇯🇵 日本 09 家宽' })
      })
    );
  });

  it('uses remote default node keywords before the built-in fallback', async () => {
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
            selector: {
              now: 'COMPATIBLE',
              all: ['香港 01', 'Japan 09 Home']
            },
            '香港 01': {},
            'Japan 09 Home': {}
          }
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = createMihomoRuntime({
      binaryPath: 'C:/YouYu/mihomo.exe',
      userDataDir,
      readSettings: async () => makeSettings({ defaultNodeKeywords: ['香港'] }),
      spawnProcess: () => child as never
    });

    await runtime.start();

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/selector',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: '香港 01' })
      })
    );
  });
});
