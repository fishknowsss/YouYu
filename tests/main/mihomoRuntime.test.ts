import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    systemProxyEnabled: true,
    dnsEnhanced: true,
    snifferEnabled: true,
    tunEnabled: false,
    allowLan: false,
    ...overrides
  };
}

afterEach(async () => {
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
});
