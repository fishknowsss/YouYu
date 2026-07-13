import { describe, expect, it, vi } from 'vitest';
import {
  createTemporaryRuntimeLeaseManager,
  createTrafficRegistrationCoordinator
} from '../../src/main/traffic/registration';

const input = { name: 'Alice', passphrase: 'secret' };

function createHarness(options: {
  register: (proxyUrl?: string) => Promise<void>;
  pending?: typeof input;
  runtimeAvailable?: boolean;
  hasSubscription?: boolean;
}) {
  let runtimeAvailable = options.runtimeAvailable ?? false;
  const register = vi.fn((_input: typeof input, request?: { proxyUrl?: string }) =>
    options.register(request?.proxyUrl)
  );
  const registerPendingIdentity = vi.fn(async () => undefined);
  const clearIdentity = vi.fn(async () => undefined);
  const stopRuntime = vi.fn(async () => undefined);
  const releaseTemporaryRuntime = vi.fn(async () => {
    runtimeAvailable = false;
  });
  const acquireTemporaryRuntime = vi.fn(async () => {
    runtimeAvailable = true;
    return releaseTemporaryRuntime;
  });
  const log = vi.fn();
  const coordinator = createTrafficRegistrationCoordinator({
    reporter: { register },
    store: {
      registerPendingIdentity,
      getPendingRegistration: vi.fn(async () => options.pending),
      clearIdentity
    },
    hasSubscription: async () => options.hasSubscription ?? true,
    acquireTemporaryRuntime,
    stopRuntime,
    getProxyUrl: () => (runtimeAvailable ? 'http://127.0.0.1:7890' : undefined),
    log
  });

  return {
    coordinator,
    register,
    registerPendingIdentity,
    clearIdentity,
    acquireTemporaryRuntime,
    releaseTemporaryRuntime,
    stopRuntime,
    log
  };
}

describe('createTrafficRegistrationCoordinator', () => {
  it('always stops a temporary runtime after a permanent proxy activation failure', async () => {
    const harness = createHarness({
      register: async (proxyUrl) => {
        if (!proxyUrl) throw new Error('fetch failed');
        throw new Error('traffic activation failed: 403 invalid passphrase');
      }
    });

    await expect(harness.coordinator.register(input)).rejects.toThrow('invalid passphrase');
    expect(harness.acquireTemporaryRuntime).toHaveBeenCalledOnce();
    expect(harness.releaseTemporaryRuntime).toHaveBeenCalledOnce();
    expect(harness.stopRuntime).not.toHaveBeenCalled();
    expect(harness.registerPendingIdentity).not.toHaveBeenCalled();
  });

  it('stores a transient proxy activation failure and stops the temporary runtime', async () => {
    const harness = createHarness({
      register: async (proxyUrl) => {
        if (!proxyUrl) throw new Error('fetch failed');
        throw new Error('traffic request timed out');
      }
    });

    await harness.coordinator.register(input);
    expect(harness.registerPendingIdentity).toHaveBeenCalledWith(input);
    expect(harness.releaseTemporaryRuntime).toHaveBeenCalledOnce();
  });

  it('reports temporary runtime cleanup failure after registration succeeds', async () => {
    const harness = createHarness({
      register: async (proxyUrl) => {
        if (!proxyUrl) throw new Error('fetch failed');
      }
    });
    harness.releaseTemporaryRuntime.mockRejectedValueOnce(new Error('proxy restore failed'));

    await expect(harness.coordinator.register(input)).rejects.toThrow('proxy restore failed');
    expect(harness.releaseTemporaryRuntime).toHaveBeenCalledOnce();
  });

  it('stores registration when the temporary runtime cannot start', async () => {
    const harness = createHarness({ register: async () => Promise.reject(new Error('fetch failed')) });
    harness.acquireTemporaryRuntime.mockRejectedValueOnce(new Error('mihomo failed'));

    await harness.coordinator.register(input);
    expect(harness.registerPendingIdentity).toHaveBeenCalledWith(input);
    expect(harness.releaseTemporaryRuntime).not.toHaveBeenCalled();
  });

  it('clears identity and stops the proxy after permanent pending activation failure', async () => {
    const harness = createHarness({
      pending: input,
      runtimeAvailable: true,
      register: async () => {
        throw new Error('traffic activation failed: 409 identity conflict');
      }
    });

    await expect(harness.coordinator.activatePending()).rejects.toThrow('identity conflict');
    expect(harness.clearIdentity).toHaveBeenCalledWith('traffic activation failed: 409 identity conflict');
    expect(harness.stopRuntime).toHaveBeenCalledOnce();
  });

  it('keeps a pending identity and running proxy after a transient activation failure', async () => {
    const harness = createHarness({
      pending: input,
      runtimeAvailable: true,
      register: async () => {
        throw new Error('traffic request timed out');
      }
    });

    await expect(harness.coordinator.activatePending()).resolves.toBe(false);
    expect(harness.clearIdentity).not.toHaveBeenCalled();
    expect(harness.stopRuntime).not.toHaveBeenCalled();
  });

  it('still stops the runtime and throws the original permanent error when identity cleanup fails', async () => {
    const originalError = new Error('traffic activation failed: 409 identity conflict');
    const harness = createHarness({
      pending: input,
      runtimeAvailable: true,
      register: async () => {
        throw originalError;
      }
    });
    harness.clearIdentity.mockRejectedValueOnce(new Error('database unavailable'));
    harness.stopRuntime.mockRejectedValueOnce(new Error('proxy restore failed'));

    let thrown: unknown;
    try {
      await harness.coordinator.activatePending();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);
    expect(harness.clearIdentity).toHaveBeenCalledOnce();
    expect(harness.stopRuntime).toHaveBeenCalledOnce();
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining('清除流量身份失败'));
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining('停止代理失败'));
  });
});

describe('createTemporaryRuntimeLeaseManager', () => {
  it('does not stop a runtime requested by the user while direct registration is waiting', async () => {
    const directAttempt = deferred<void>();
    let runtimeIntent: number | undefined;
    let running = false;
    let attempts = 0;
    const startRuntime = vi.fn(async () => {
      running = true;
    });
    const stopRuntime = vi.fn(async () => {
      running = false;
    });
    const leases = createTemporaryRuntimeLeaseManager({
      isRuntimeRunning: () => running,
      captureRuntimeIntent: () => runtimeIntent,
      startRuntime,
      stopRuntime
    });
    const coordinator = createTrafficRegistrationCoordinator({
      reporter: {
        register: async () => {
          attempts += 1;
          if (attempts === 1) await directAttempt.promise;
        }
      },
      store: {
        registerPendingIdentity: async () => undefined,
        getPendingRegistration: async () => undefined,
        clearIdentity: async () => undefined
      },
      hasSubscription: async () => true,
      acquireTemporaryRuntime: leases.acquire,
      stopRuntime,
      getProxyUrl: () => (running ? 'http://127.0.0.1:7890' : undefined)
    });

    const registration = coordinator.register(input);
    await vi.waitFor(() => expect(attempts).toBe(1));
    runtimeIntent = 7;
    directAttempt.reject(new Error('fetch failed'));
    await registration;

    expect(startRuntime).toHaveBeenCalledWith(7);
    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it('does not stop a temporary runtime when the user requests start during startup', async () => {
    const startAttempt = deferred<void>();
    let runtimeIntent: number | undefined;
    let running = false;
    const stopRuntime = vi.fn(async () => {
      running = false;
    });
    const startRuntime = vi.fn(async () => {
      await startAttempt.promise;
      running = true;
    });
    const leases = createTemporaryRuntimeLeaseManager({
      isRuntimeRunning: () => running,
      captureRuntimeIntent: () => runtimeIntent,
      startRuntime,
      stopRuntime
    });

    const releasePromise = leases.acquire();
    await vi.waitFor(() => expect(startRuntime).toHaveBeenCalledOnce());
    runtimeIntent = 9;
    startAttempt.resolve();
    const release = await releasePromise;
    await release();

    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it('never stops a runtime it did not start', async () => {
    const startRuntime = vi.fn(async () => undefined);
    const stopRuntime = vi.fn(async () => undefined);
    const leases = createTemporaryRuntimeLeaseManager({
      isRuntimeRunning: () => true,
      captureRuntimeIntent: () => undefined,
      startRuntime,
      stopRuntime
    });

    const release = await leases.acquire();
    await release();

    expect(startRuntime).not.toHaveBeenCalled();
    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it('restores user intent that arrives while temporary runtime shutdown is in progress', async () => {
    const stopAttempt = deferred<void>();
    let runtimeIntent: number | undefined;
    let running = false;
    const startRuntime = vi.fn(async () => {
      running = true;
    });
    const stopRuntime = vi.fn(async () => {
      await stopAttempt.promise;
      running = false;
    });
    const leases = createTemporaryRuntimeLeaseManager({
      isRuntimeRunning: () => running,
      captureRuntimeIntent: () => runtimeIntent,
      startRuntime,
      stopRuntime
    });

    const release = await leases.acquire();
    const releasePromise = release();
    await vi.waitFor(() => expect(stopRuntime).toHaveBeenCalledOnce());
    runtimeIntent = 11;
    stopAttempt.resolve();
    await releasePromise;

    expect(startRuntime).toHaveBeenLastCalledWith(11);
    expect(running).toBe(true);
  });

  it('stops a temporary runtime only after its final lease is released', async () => {
    let running = false;
    const stopRuntime = vi.fn(async () => {
      running = false;
    });
    const leases = createTemporaryRuntimeLeaseManager({
      isRuntimeRunning: () => running,
      captureRuntimeIntent: () => undefined,
      startRuntime: async () => {
        running = true;
      },
      stopRuntime
    });

    const firstRelease = await leases.acquire();
    const secondRelease = await leases.acquire();
    await firstRelease();
    expect(stopRuntime).not.toHaveBeenCalled();
    await secondRelease();
    expect(stopRuntime).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
