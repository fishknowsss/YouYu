import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRuntimeCoordinator } from '../../src/main/appRuntimeCoordinator';
import type { LifecycleStatus } from '../../src/main/lifecycle';

afterEach(() => {
  vi.useRealTimers();
});

describe('AppRuntimeCoordinator', () => {
  it('singleflights duplicate starts and reports actual lifecycle state', async () => {
    let status: LifecycleStatus = 'stopped';
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = vi.fn(async () => {
      await gate;
      status = 'running';
      return 'started';
    });
    const coordinator = createCoordinator({ getStatus: () => status, start });

    const first = coordinator.start();
    const second = coordinator.start();
    expect(start).toHaveBeenCalledTimes(0);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(coordinator.inspect()).toMatchObject({ status: 'stopped', operation: 'start', generation: 1 });
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual(['started', 'started']);
    expect(coordinator.inspect()).toEqual({ status: 'running', generation: 1, operation: undefined });
  });

  it('aborts a stale start when stop takes ownership and ignores the stale finalizer', async () => {
    let status: LifecycleStatus = 'stopped';
    let startSignal: AbortSignal | undefined;
    const coordinator = createCoordinator({
      getStatus: () => status,
      start: ({ signal }) => {
        startSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      stop: async () => {
        status = 'stopped';
        return 'stopped';
      }
    });

    const starting = coordinator.start();
    await vi.waitFor(() => expect(startSignal).toBeDefined());
    const stopping = coordinator.stop();

    await expect(starting).rejects.toThrow(/superseded by stop/);
    await expect(stopping).resolves.toBe('stopped');
    expect(startSignal?.aborted).toBe(true);
    expect(coordinator.inspect()).toEqual({ status: 'stopped', generation: 2, operation: undefined });
  });

  it('keeps one unref recovery timer and skips recovery while a foreground operation is active', async () => {
    vi.useFakeTimers();
    const recover = vi.fn(async () => 'recovered');
    let canRecover = true;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = createCoordinator({
      recover,
      canRecover: () => canRecover,
      start: async () => {
        await gate;
        return 'started';
      }
    });

    coordinator.scheduleRecovery(50);
    coordinator.scheduleRecovery(50);
    expect(coordinator.hasRecoveryTimer()).toBe(true);
    const starting = coordinator.start();
    expect(coordinator.hasRecoveryTimer()).toBe(false);
    await expect(coordinator.recover()).resolves.toBeUndefined();
    expect(recover).not.toHaveBeenCalled();
    release?.();
    await starting;

    coordinator.scheduleRecovery(50);
    canRecover = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(recover).not.toHaveBeenCalled();
  });

  it('runs a timed recovery once after the foreground operation that delayed it settles', async () => {
    vi.useFakeTimers();
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const recover = vi.fn(async () => 'recovered');
    const coordinator = createCoordinator({
      start: async () => {
        await startGate;
        return 'started';
      },
      recover,
      canRecover: () => true
    });

    const starting = coordinator.start();
    coordinator.scheduleRecovery(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(recover).not.toHaveBeenCalled();

    releaseStart?.();
    await starting;
    await vi.advanceTimersByTimeAsync(0);

    expect(recover).toHaveBeenCalledOnce();
    expect(coordinator.inspect()).toMatchObject({ operation: undefined });
  });

  it('lets a foreground start supersede an active background recovery', async () => {
    let recoverySignal: AbortSignal | undefined;
    const coordinator = createCoordinator({
      recover: ({ signal }) => {
        recoverySignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('transport failed after abort')), { once: true });
        });
      }
    });
    const recovery = coordinator.recover();
    await vi.waitFor(() => expect(recoverySignal).toBeDefined());

    const start = coordinator.start();

    await expect(recovery).rejects.toThrow('superseded by start');
    await expect(start).resolves.toBe('started');
    expect(recoverySignal?.aborted).toBe(true);
    expect(coordinator.inspect()).toMatchObject({ operation: undefined, generation: 2 });
  });

  it('aborts recovery and clears timers when disposed', async () => {
    vi.useFakeTimers();
    let recoverySignal: AbortSignal | undefined;
    const coordinator = createCoordinator({
      recover: ({ signal }) => {
        recoverySignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    });
    coordinator.scheduleRecovery(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(recoverySignal).toBeDefined());

    coordinator.dispose();

    expect(recoverySignal?.aborted).toBe(true);
    expect(coordinator.hasRecoveryTimer()).toBe(false);
    expect(() => coordinator.start()).toThrow(/disposed/);
  });

  it('detaches a stopped recovery so cleanup failure can schedule a replacement immediately', async () => {
    vi.useFakeTimers();
    let finishCanceledRecovery: (() => void) | undefined;
    const canceledRecoveryCleanup = new Promise<void>((resolve) => {
      finishCanceledRecovery = resolve;
    });
    const recover = vi
      .fn<(context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementationOnce(
        ({ signal }) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                void canceledRecoveryCleanup.then(() => reject(signal.reason));
              },
              { once: true }
            );
          })
      )
      .mockResolvedValueOnce('replacement');
    const coordinator = createCoordinator({ recover });
    const first = coordinator.recover();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());

    coordinator.stopRecovery();
    expect(coordinator.inspect().operation).toBeUndefined();
    coordinator.scheduleRecovery(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));

    finishCanceledRecovery?.();
    await expect(first).rejects.toThrow('recovery stopped');
    expect(coordinator.inspect().operation).toBeUndefined();
    coordinator.dispose();
  });
});

describe('AppRuntimeCoordinator index integration', () => {
  it('removes the legacy runtime-recovery state machine and routes failures through the coordinator', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');

    expect(source).not.toMatch(/runtimeRecovery(?:Timer|Running)/);
    expect(source).not.toContain('function scheduleRuntimeRecovery');
    expect(source).not.toContain('function runRuntimeRecovery');
    expect(source).toContain('createAppRuntimeCoordinator');
    expect(source).toContain('appRuntimeCoordinator.scheduleRecovery(runtimeRecoveryInitialDelayMs)');
  });

  it('routes foreground start, stop, and restart through one coordinator while perform functions stay internal', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const wiring = source.slice(
      source.indexOf('const appRuntimeCoordinator = createAppRuntimeCoordinator'),
      source.indexOf('const temporaryRegistrationRuntime')
    );
    const start = source.slice(
      source.indexOf('async function performStartProxy'),
      source.indexOf('async function selectBestAutoNode')
    );
    const restart = source.slice(
      source.indexOf('async function startLifecycleWithSafeRetry'),
      source.indexOf('async function handleTrafficIdentityInvalidated')
    );
    const stop = source.slice(
      source.indexOf('async function performStopProxy'),
      source.indexOf('async function runIssueTargetedRepair')
    );

    expect(start).toContain('return appRuntimeCoordinator.start(signal)');
    expect(start).toContain('startLifecycleWithSafeRetry(signal, intentGeneration)');
    expect(stop).toContain('return appRuntimeCoordinator.stop()');
    expect(restart).toContain('return appRuntimeCoordinator.restart(signal)');
    expect(restart).toContain('restartLifecycleForIntent(intentGeneration, signal)');
    expect(wiring).toContain('start: ({ signal }) => performStartProxy(signal)');
    expect(wiring).toContain('stop: ({ signal }) => performStopProxy(signal)');
    expect(wiring).toContain('restart: ({ signal }) => performRestartLifecycleForUser(signal)');
    expect(wiring).toContain('recover: ({ signal }) => performRuntimeRecovery(signal)');
  });

  it('clears recovery at destructive boundaries, disposes only after successful cleanup, and remains reusable on failure', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const cleanup = source.slice(
      source.indexOf('async function cleanupBeforeExit'),
      source.indexOf('const gotSingleInstanceLock')
    );
    const failedCleanup = cleanup.slice(cleanup.indexOf('catch (error)'), cleanup.indexOf('cleanupFinished = true'));

    expect(cleanup).toContain('appRuntimeCoordinator.stopRecovery()');
    expect(cleanup).toContain('appRuntimeCoordinator.dispose()');
    expect(failedCleanup).toContain('appRuntimeCoordinator.scheduleRecovery(0)');
    expect(failedCleanup).not.toContain('appRuntimeCoordinator.dispose()');
    expect(cleanup.indexOf('cleanupFinished = true')).toBeLessThan(cleanup.indexOf('appRuntimeCoordinator.dispose()'));
  });
});

function createCoordinator(
  overrides: Partial<Parameters<typeof createAppRuntimeCoordinator<string, string, string, string>>[0]> = {}
) {
  return createAppRuntimeCoordinator<string, string, string, string>({
    getStatus: () => 'stopped',
    start: async () => 'started',
    stop: async () => 'stopped',
    restart: async () => 'restarted',
    recover: async () => 'recovered',
    ...overrides
  });
}
