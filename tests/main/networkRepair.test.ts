import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { clearMihomoRepairCache, runNetworkRepair } from '../../src/main/networkRepair';

describe('runNetworkRepair', () => {
  it('runs a diagnostic-specific safe repair before the complete repair chain', async () => {
    const calls: string[] = [];
    let status: 'running' | 'stopped' | 'failed' = 'running';

    await runNetworkRepair(
      {
        getStatus: () => status,
        captureRuntimeIntent: () => 2,
        isRuntimeIntentCurrent: () => true,
        pauseBackgroundWork: () => calls.push('pause'),
        prepareRunningRuntime: async () => {
          calls.push('prepare');
        },
        runTargetedRepair: async (issueKind) => {
          calls.push(`targeted:${issueKind}`);
        },
        repairLifecycle: async () => {
          calls.push('complete-repair');
          status = 'stopped';
        },
        clearRuntimeCache: async () => {
          calls.push('clear-cache');
        },
        startRuntime: async () => {
          calls.push('start');
          status = 'running';
        },
        resumeRunningWork: () => calls.push('resume-work'),
        createSnapshot: async () => ({ status })
      },
      { issueKind: 'dns' }
    );

    expect(calls).toEqual([
      'prepare',
      'pause',
      'targeted:dns',
      'complete-repair',
      'clear-cache',
      'start',
      'resume-work'
    ]);
  });

  it('continues the complete repair when a best-effort targeted step fails', async () => {
    const calls: string[] = [];
    const targetedError = new Error('DNS service unavailable');
    let status: 'running' | 'stopped' | 'failed' = 'stopped';

    await runNetworkRepair(
      {
        getStatus: () => status,
        captureRuntimeIntent: () => undefined,
        isRuntimeIntentCurrent: () => false,
        pauseBackgroundWork: () => calls.push('pause'),
        prepareRunningRuntime: vi.fn(async () => undefined),
        runTargetedRepair: async () => {
          calls.push('targeted');
          throw targetedError;
        },
        onTargetedRepairError: (issueKind, error) => {
          expect(issueKind).toBe('network');
          expect(error).toBe(targetedError);
          calls.push('targeted-error');
        },
        repairLifecycle: async () => {
          calls.push('complete-repair');
          status = 'stopped';
        },
        clearRuntimeCache: async () => {
          calls.push('clear-cache');
        },
        startRuntime: vi.fn(async () => undefined),
        resumeRunningWork: vi.fn(),
        createSnapshot: async () => ({ status })
      },
      { issueKind: 'network' }
    );

    expect(calls).toEqual(['pause', 'targeted', 'targeted-error', 'complete-repair', 'clear-cache']);
  });

  it('repairs a running runtime to stopped before starting a fresh runtime', async () => {
    const calls: string[] = [];
    let status: 'running' | 'stopped' | 'failed' = 'running';
    const snapshot = { status: 'running' as const };

    await expect(
      runNetworkRepair({
        getStatus: () => status,
        captureRuntimeIntent: () => 7,
        isRuntimeIntentCurrent: (generation) => generation === 7,
        pauseBackgroundWork: () => calls.push('pause'),
        prepareRunningRuntime: async () => {
          calls.push('prepare');
        },
        repairLifecycle: async () => {
          calls.push('repair');
          status = 'stopped';
        },
        clearRuntimeCache: async () => {
          calls.push('clear-cache');
        },
        startRuntime: async (_signal, generation) => {
          calls.push(`start:${generation}`);
          status = 'running';
        },
        resumeRunningWork: () => calls.push('resume-work'),
        createSnapshot: async () => snapshot
      })
    ).resolves.toBe(snapshot);

    expect(calls).toEqual(['prepare', 'pause', 'repair', 'clear-cache', 'start:7', 'resume-work']);
  });

  it('recovers a failed runtime when the user still intends it to run', async () => {
    const calls: string[] = [];
    let status: 'running' | 'stopped' | 'failed' = 'failed';

    await runNetworkRepair({
      getStatus: () => status,
      captureRuntimeIntent: () => 11,
      isRuntimeIntentCurrent: (generation) => generation === 11,
      pauseBackgroundWork: () => calls.push('pause'),
      prepareRunningRuntime: async () => {
        calls.push('prepare');
      },
      repairLifecycle: async () => {
        calls.push('repair');
        status = 'stopped';
      },
      clearRuntimeCache: async () => {
        calls.push('clear-cache');
      },
      startRuntime: async (_signal, generation) => {
        calls.push(`start:${generation}`);
        status = 'running';
      },
      resumeRunningWork: () => calls.push('resume-work'),
      createSnapshot: async () => ({ status })
    });

    expect(calls).toEqual(['pause', 'repair', 'clear-cache', 'start:11', 'resume-work']);
  });

  it('keeps an intentionally stopped runtime stopped', async () => {
    const calls: string[] = [];
    let status: 'running' | 'stopped' | 'failed' = 'stopped';

    await runNetworkRepair({
      getStatus: () => status,
      captureRuntimeIntent: () => undefined,
      isRuntimeIntentCurrent: () => false,
      pauseBackgroundWork: () => calls.push('pause'),
      prepareRunningRuntime: async () => {
        calls.push('prepare');
      },
      repairLifecycle: async () => {
        calls.push('repair');
        status = 'stopped';
      },
      clearRuntimeCache: async () => {
        calls.push('clear-cache');
      },
      startRuntime: async () => {
        calls.push('start');
      },
      resumeRunningWork: () => calls.push('resume-work'),
      createSnapshot: async () => ({ status })
    });

    expect(calls).toEqual(['pause', 'repair', 'clear-cache']);
  });

  it('does not revive the runtime after the user cancels its running intent during repair', async () => {
    let status: 'running' | 'stopped' | 'failed' = 'running';
    const startRuntime = vi.fn(async () => undefined);

    await expect(
      runNetworkRepair({
        getStatus: () => status,
        captureRuntimeIntent: () => 13,
        isRuntimeIntentCurrent: () => false,
        pauseBackgroundWork: vi.fn(),
        prepareRunningRuntime: vi.fn(async () => undefined),
        repairLifecycle: async () => {
          status = 'stopped';
        },
        clearRuntimeCache: vi.fn(async () => undefined),
        startRuntime,
        resumeRunningWork: vi.fn(),
        createSnapshot: async () => ({ status })
      })
    ).rejects.toThrow('proxy start canceled');

    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('repairs to stopped without an intermediate restart when the caller will relaunch the app', async () => {
    const calls: string[] = [];
    let status: 'running' | 'stopped' | 'failed' = 'running';

    await runNetworkRepair(
      {
        getStatus: () => status,
        captureRuntimeIntent: () => 3,
        isRuntimeIntentCurrent: () => true,
        pauseBackgroundWork: () => calls.push('pause'),
        prepareRunningRuntime: async () => {
          calls.push('prepare');
        },
        repairLifecycle: async () => {
          calls.push('repair');
          status = 'stopped';
        },
        clearRuntimeCache: async () => {
          calls.push('clear-cache');
        },
        startRuntime: async () => {
          calls.push('start');
        },
        resumeRunningWork: () => calls.push('resume-work'),
        createSnapshot: async () => ({ status })
      },
      { resumeRuntime: false }
    );

    expect(calls).toEqual(['prepare', 'pause', 'repair', 'clear-cache']);
  });

  it('clears volatile Mihomo state after a supplemental repair failure stopped the core', async () => {
    const repairError = new Error('dns repair failed');
    let status: 'running' | 'stopped' | 'failed' = 'running';
    const clearRuntimeCache = vi.fn(async () => undefined);
    const startRuntime = vi.fn(async () => undefined);

    await expect(
      runNetworkRepair({
        getStatus: () => status,
        captureRuntimeIntent: () => 5,
        isRuntimeIntentCurrent: () => true,
        pauseBackgroundWork: vi.fn(),
        prepareRunningRuntime: vi.fn(async () => undefined),
        repairLifecycle: async () => {
          status = 'stopped';
          throw repairError;
        },
        clearRuntimeCache,
        startRuntime,
        resumeRunningWork: vi.fn(),
        createSnapshot: async () => ({ status })
      })
    ).rejects.toBe(repairError);

    expect(clearRuntimeCache).toHaveBeenCalledOnce();
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('does not clear live Mihomo state after the critical proxy-disable stage fails', async () => {
    const repairError = new Error('WinINet notification failed');
    const clearRuntimeCache = vi.fn(async () => undefined);

    await expect(
      runNetworkRepair({
        getStatus: () => 'failed',
        captureRuntimeIntent: () => 9,
        isRuntimeIntentCurrent: () => true,
        pauseBackgroundWork: vi.fn(),
        prepareRunningRuntime: vi.fn(async () => undefined),
        repairLifecycle: async () => {
          throw repairError;
        },
        clearRuntimeCache,
        startRuntime: vi.fn(async () => undefined),
        resumeRunningWork: vi.fn(),
        createSnapshot: async () => ({ status: 'failed' as const })
      })
    ).rejects.toBe(repairError);

    expect(clearRuntimeCache).not.toHaveBeenCalled();
  });
});

describe('clearMihomoRepairCache', () => {
  it('removes only the volatile Mihomo cache database', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'youyu-repair-cache-'));
    const workDir = join(userDataDir, 'mihomo');
    const cachePath = join(workDir, 'cache.db');
    const configPath = join(workDir, 'config.yaml');
    const subscriptionPath = join(workDir, 'subscription-cache.yaml');
    try {
      await mkdir(workDir, { recursive: true });
      await Promise.all([
        writeFile(cachePath, 'volatile'),
        writeFile(configPath, 'config'),
        writeFile(subscriptionPath, 'subscription')
      ]);

      await clearMihomoRepairCache(userDataDir);

      await expect(access(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(configPath)).resolves.toBeUndefined();
      await expect(access(subscriptionPath)).resolves.toBeUndefined();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
