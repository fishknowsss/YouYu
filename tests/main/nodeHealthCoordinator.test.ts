import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeHealthCoordinator, type NodeHealthContext } from '../../src/main/nodeHealthCoordinator';

function context(overrides: Partial<NodeHealthContext> = {}): NodeHealthContext {
  return {
    nodeName: 'JP Tokyo',
    running: true,
    direct: false,
    revision: 'runtime-1',
    ...overrides
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

afterEach(() => {
  vi.useRealTimers();
});

describe('createNodeHealthCoordinator', () => {
  it('discards an old delayed probe after the current node changes', async () => {
    vi.useFakeTimers();
    let current = context();
    const oldProbe = deferred<number | undefined>();
    const newProbe = deferred<number | undefined>();
    const signals: AbortSignal[] = [];
    const probeDelay = vi
      .fn(async (_context: NodeHealthContext, signal: AbortSignal) => {
        signals.push(signal);
        return oldProbe.promise;
      })
      .mockImplementationOnce(async (_context, signal) => {
        signals.push(signal);
        return oldProbe.promise;
      })
      .mockImplementationOnce(async (_context, signal) => {
        signals.push(signal);
        return newProbe.promise;
      });
    const coordinator = createNodeHealthCoordinator({
      totalAvailabilityCount: 15,
      initialDelayMs: 0,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 2,
      readContext: async () => current,
      probeDelay
    });
    coordinator.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(probeDelay).toHaveBeenCalledOnce());
    expect(coordinator.inspect().health).toMatchObject({ nodeName: 'JP Tokyo', delayStatus: 'testing' });

    current = context({ nodeName: 'US West', revision: 'runtime-2' });
    coordinator.reschedule(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(probeDelay).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    oldProbe.resolve(18);
    newProbe.resolve(42);

    await vi.waitFor(() =>
      expect(coordinator.inspect().health).toMatchObject({
        nodeName: 'US West',
        delayStatus: 'measured',
        delay: 42
      })
    );
    coordinator.dispose();
  });

  it('keeps the two-failure threshold and retries before recovering the node', async () => {
    vi.useFakeTimers();
    let current = context();
    const recoverNode = vi.fn(async () => {
      current = context({ nodeName: 'US West', revision: 'runtime-2' });
      return 'US West';
    });
    const onTransientFailure = vi.fn();
    const coordinator = createNodeHealthCoordinator({
      totalAvailabilityCount: 15,
      initialDelayMs: 60_000,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 2,
      readContext: async () => current,
      probeDelay: vi.fn(async () => undefined),
      recoverNode,
      onTransientFailure
    });
    coordinator.start();

    await coordinator.checkNow();
    expect(onTransientFailure).toHaveBeenCalledWith('JP Tokyo', 1);
    expect(recoverNode).not.toHaveBeenCalled();
    expect(coordinator.inspect().failures).toEqual({ nodeName: 'JP Tokyo', count: 1 });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(recoverNode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(recoverNode).toHaveBeenCalledOnce());
    expect(coordinator.inspect().health).toMatchObject({ nodeName: 'US West', delayStatus: 'untested' });
    expect(coordinator.inspect().failures).toEqual({ nodeName: 'US West', count: 0 });
    coordinator.dispose();
  });

  it('resets consecutive background failures after a successful manual delay result', async () => {
    vi.useFakeTimers();
    const recoverNode = vi.fn(async () => 'US West');
    const onTransientFailure = vi.fn();
    const coordinator = createNodeHealthCoordinator({
      totalAvailabilityCount: 15,
      initialDelayMs: 60_000,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 2,
      readContext: async () => context(),
      probeDelay: async () => undefined,
      recoverNode,
      onTransientFailure
    });
    coordinator.start();

    await coordinator.checkNow();
    expect(coordinator.inspect().failures).toEqual({ nodeName: 'JP Tokyo', count: 1 });
    await coordinator.recordManualDelay('JP Tokyo', 27, 'tested');
    expect(coordinator.inspect().failures).toEqual({ nodeName: 'JP Tokyo', count: 0 });

    await coordinator.checkNow();
    expect(coordinator.inspect().failures).toEqual({ nodeName: 'JP Tokyo', count: 1 });
    expect(onTransientFailure).toHaveBeenLastCalledWith('JP Tokyo', 1);
    expect(recoverNode).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('gives a manual current-node result priority over a background probe', async () => {
    vi.useFakeTimers();
    const background = deferred<number | undefined>();
    const onHealthChanged = vi.fn();
    const coordinator = createNodeHealthCoordinator({
      totalAvailabilityCount: 15,
      initialDelayMs: 60_000,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 2,
      readContext: async () => context(),
      probeDelay: async () => background.promise,
      onHealthChanged,
      now: () => new Date('2026-08-01T08:00:00.000Z')
    });
    coordinator.start();
    const backgroundRun = coordinator.checkNow();
    await vi.waitFor(() =>
      expect(coordinator.inspect().health).toMatchObject({ nodeName: 'JP Tokyo', delayStatus: 'testing' })
    );

    await coordinator.recordManualDelay('JP Tokyo', 27, 'tested');

    expect(coordinator.inspect().health).toMatchObject({
      nodeName: 'JP Tokyo',
      delayStatus: 'measured',
      delay: 27,
      delayCheckedAt: '2026-08-01T08:00:00.000Z'
    });
    expect(onHealthChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodeName: 'JP Tokyo', delayStatus: 'measured', delay: 27 })
    );
    expect(coordinator.inspect().timer?.hasRef?.()).toBe(false);
    background.resolve(undefined);
    await expect(backgroundRun).rejects.toThrow('superseded by manual result');
    expect(coordinator.inspect().health.delay).toBe(27);
    coordinator.dispose();
  });

  it('does not save or publish an old availability result after the node changes', async () => {
    vi.useFakeTimers();
    type AvailabilityRecord = { nodeName: string; checkedAt: string; percent: number };
    let current = context();
    const oldAvailability = deferred<AvailabilityRecord>();
    const saveAvailability = vi.fn(async () => true);
    const coordinator = createNodeHealthCoordinator<NodeHealthContext, AvailabilityRecord>({
      totalAvailabilityCount: 15,
      initialDelayMs: 60_000,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 2,
      readContext: async () => current,
      probeDelay: async () => 25,
      readCachedAvailability: async () => undefined,
      probeAvailability: async () => oldAvailability.promise,
      saveAvailability,
      toAvailabilitySnapshot: (record) => ({
        status: 'measured',
        totalCount: 15,
        availableCount: Math.round((record.percent / 100) * 15),
        percent: record.percent,
        tone: 'success',
        checkedAt: record.checkedAt
      })
    });
    coordinator.start();
    await coordinator.checkNow();
    await vi.waitFor(() => expect(coordinator.inspect().health.availability.status).toBe('testing'));

    current = context({ nodeName: 'US West', revision: 'runtime-2' });
    await coordinator.getSnapshot(current);
    oldAvailability.resolve({ nodeName: 'JP Tokyo', checkedAt: '2026-08-01T08:00:00.000Z', percent: 100 });

    await vi.waitFor(() => expect(coordinator.inspect().activeAvailability).toBe(false));
    expect(saveAvailability).not.toHaveBeenCalled();
    expect(coordinator.inspect().health).toMatchObject({
      nodeName: 'US West',
      availability: { status: 'untested' }
    });
    coordinator.dispose();
  });

  it('cancels a revision-stale probe and schedules a fresh-context check', async () => {
    vi.useFakeTimers();
    let current = context();
    const staleProbe = deferred<number | undefined>();
    const signals: AbortSignal[] = [];
    const probeDelay = vi
      .fn<(probeContext: NodeHealthContext, signal: AbortSignal) => Promise<number | undefined>>()
      .mockImplementationOnce(async (_probeContext, signal) => {
        signals.push(signal);
        return staleProbe.promise;
      })
      .mockImplementationOnce(async (_probeContext, signal) => {
        signals.push(signal);
        return 31;
      });
    const coordinator = createNodeHealthCoordinator({
      totalAvailabilityCount: 15,
      initialDelayMs: 60_000,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 2,
      readContext: async () => current,
      probeDelay
    });
    coordinator.start();
    const staleRun = coordinator.checkNow();
    await vi.waitFor(() => expect(probeDelay).toHaveBeenCalledOnce());

    current = context({ revision: 'runtime-2' });
    await coordinator.getSnapshot(current);

    expect(signals[0]?.aborted).toBe(true);
    expect(coordinator.inspect().timer).toBeDefined();
    staleProbe.resolve(99);
    await expect(staleRun).rejects.toThrow('context changed');
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(coordinator.inspect().health).toMatchObject({ delayStatus: 'measured', delay: 31 }));
    expect(coordinator.inspect().failures.count).toBe(0);
    coordinator.dispose();
  });

  it('singleflights availability work for the same context', async () => {
    vi.useFakeTimers();
    type AvailabilityRecord = { nodeName: string; checkedAt: string; percent: number };
    const availability = deferred<AvailabilityRecord>();
    const probeAvailability = vi.fn(async () => availability.promise);
    const coordinator = createNodeHealthCoordinator<NodeHealthContext, AvailabilityRecord>({
      totalAvailabilityCount: 15,
      initialDelayMs: 60_000,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 2,
      readContext: async () => context(),
      probeDelay: async () => 25,
      readCachedAvailability: async () => undefined,
      probeAvailability,
      saveAvailability: async () => true,
      toAvailabilitySnapshot: (record) => ({
        status: 'measured',
        totalCount: 15,
        availableCount: Math.round((record.percent / 100) * 15),
        percent: record.percent,
        tone: 'success',
        checkedAt: record.checkedAt
      })
    });
    coordinator.start();

    await coordinator.checkNow();
    await vi.waitFor(() => expect(probeAvailability).toHaveBeenCalledOnce());
    await coordinator.checkNow();
    expect(probeAvailability).toHaveBeenCalledOnce();

    availability.resolve({ nodeName: 'JP Tokyo', checkedAt: '2026-08-01T08:00:00.000Z', percent: 100 });
    await vi.waitFor(() => expect(coordinator.inspect().activeAvailability).toBe(false));
    expect(coordinator.inspect().health.availability).toMatchObject({ status: 'measured', percent: 100 });
    coordinator.dispose();
  });

  it('stops and disposes without allowing late results or timers to revive', async () => {
    vi.useFakeTimers();
    const delayedProbe = deferred<number | undefined>();
    let signal: AbortSignal | undefined;
    const probeDelay = vi.fn(async (_probeContext: NodeHealthContext, operationSignal: AbortSignal) => {
      signal = operationSignal;
      return delayedProbe.promise;
    });
    const coordinator = createNodeHealthCoordinator({
      totalAvailabilityCount: 15,
      initialDelayMs: 60_000,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 2,
      readContext: async () => context(),
      probeDelay
    });
    coordinator.start();
    const pending = coordinator.checkNow();
    await vi.waitFor(() => expect(probeDelay).toHaveBeenCalledOnce());

    coordinator.stop();
    expect(signal?.aborted).toBe(true);
    expect(coordinator.inspect()).toMatchObject({
      started: false,
      activeDelay: false,
      activeAvailability: false,
      timer: undefined,
      health: { delayStatus: 'untested' }
    });
    delayedProbe.resolve(44);
    await expect(pending).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probeDelay).toHaveBeenCalledOnce();
    expect(coordinator.inspect().health.delay).toBeUndefined();

    coordinator.dispose();
    expect(() => coordinator.start()).toThrow('disposed');
  });

  it('does not publish a recovered snapshot when stop wins while the recovery hook is waiting', async () => {
    vi.useFakeTimers();
    let current = context();
    const recoveryHookStarted = deferred<void>();
    const releaseRecoveryHook = deferred<void>();
    const published: string[] = [];
    let hookSignal: AbortSignal | undefined;
    const coordinator = createNodeHealthCoordinator({
      totalAvailabilityCount: 15,
      initialDelayMs: 60_000,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 1,
      readContext: async () => current,
      probeDelay: async () => undefined,
      recoverNode: async () => {
        current = context({ nodeName: 'US West', revision: 'runtime-2' });
        return 'US West';
      },
      async onRecovered(_nodeName, signal) {
        hookSignal = signal;
        recoveryHookStarted.resolve();
        await releaseRecoveryHook.promise;
        signal.throwIfAborted();
        published.push('snapshot');
      }
    });
    coordinator.start();

    const running = coordinator.checkNow();
    await recoveryHookStarted.promise;
    coordinator.stop();
    expect(hookSignal?.aborted).toBe(true);
    releaseRecoveryHook.resolve();

    await expect(running).rejects.toThrow('node health coordinator stopped');
    expect(published).toEqual([]);
    expect(coordinator.inspect().timer).toBeUndefined();
    coordinator.dispose();
  });

  it('reports a context-read failure and keeps the monitor scheduled', async () => {
    vi.useFakeTimers();
    const readContext = vi
      .fn<() => Promise<NodeHealthContext>>()
      .mockRejectedValueOnce(new Error('controller unavailable'))
      .mockResolvedValue(context());
    const onBackgroundError = vi.fn();
    const probeDelay = vi.fn(async () => 22);
    const coordinator = createNodeHealthCoordinator({
      totalAvailabilityCount: 15,
      initialDelayMs: 0,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 2,
      readContext,
      probeDelay,
      onBackgroundError
    });
    coordinator.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledOnce());
    expect(coordinator.inspect().timer).toBeDefined();

    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() => expect(probeDelay).toHaveBeenCalledOnce());
    expect(coordinator.inspect().health).toMatchObject({ delayStatus: 'measured', delay: 22 });
    coordinator.dispose();
  });
});
