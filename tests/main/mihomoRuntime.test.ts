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
    settingsVersion: 1,
    subscriptionUrl: 'https://example.com/sub',
    controllerSecret: 'local-secret',
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'smart',
    selectedNode: '',
    systemProxyEnabled: true,
    dnsEnhanced: true,
    snifferEnabled: true,
    tunEnabled: true,
    strictRouteEnabled: true,
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

  it('prefers the Taiwan 08 home node when mihomo starts without a saved node', async () => {
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
      'http://127.0.0.1:9090/proxies/%E8%87%AA%E5%8A%A8%E9%80%89%E6%8B%A9',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: '🇹🇼 台湾 08 家宽' })
      })
    );
  });

  it('restores the saved node instead of replacing it with the default on startup', async () => {
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
      spawnProcess: () => child as never
    });

    await runtime.start();

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/%E8%87%AA%E5%8A%A8%E9%80%89%E6%8B%A9',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: '美国 01' })
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

  it('routes the top selector back through the group that contains the saved node', async () => {
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
      'http://127.0.0.1:9090/proxies/%E8%87%AA%E5%8A%A8%E9%80%89%E6%8B%A9',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: '🇯🇵 日本 08 家宽' })
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
});
