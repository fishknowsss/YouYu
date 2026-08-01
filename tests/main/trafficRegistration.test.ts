import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TrafficReporter } from '../../src/main/traffic/reporter';
import {
  createTemporaryRuntimeLeaseManager,
  createTrafficRegistrationCoordinator
} from '../../src/main/traffic/registration';
import { TrafficStore } from '../../src/main/traffic/store';

const input = { name: 'Alice', passphrase: 'secret' };

function createHarness(options: {
  register: (proxyUrl?: string) => Promise<void>;
  pending?: typeof input;
  getPendingRegistration?: () => Promise<typeof input | undefined>;
  runtimeAvailable?: boolean;
  hasSubscription?: boolean;
}) {
  let runtimeAvailable = options.runtimeAvailable ?? false;
  const register = vi.fn((_input: typeof input, request?: { proxyUrl?: string }) =>
    options.register(request?.proxyUrl)
  );
  const registerPendingIdentity = vi.fn(async () => undefined);
  const getPendingRegistration = vi.fn(options.getPendingRegistration ?? (async () => options.pending));
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
      getPendingRegistration,
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
    getPendingRegistration,
    clearIdentity,
    acquireTemporaryRuntime,
    releaseTemporaryRuntime,
    stopRuntime,
    log
  };
}

describe('createTrafficRegistrationCoordinator', () => {
  it('rejects reentry before invoking the second foreground critical section and releases after settlement', async () => {
    const harness = createHarness({ register: async () => undefined });
    const firstResponse = deferred<void>();
    const firstOperation = vi.fn(async () => {
      await firstResponse.promise;
      return 'first';
    });
    const secondOperation = vi.fn(async () => 'second');

    const first = harness.coordinator.runExclusiveForeground(firstOperation);
    await vi.waitFor(() => expect(firstOperation).toHaveBeenCalledOnce());
    await expect(harness.coordinator.runExclusiveForeground(secondOperation)).rejects.toMatchObject({
      message: '流量登记正在进行，请稍后重试',
      code: 'REGISTRATION_IN_PROGRESS'
    });
    expect(secondOperation).not.toHaveBeenCalled();

    firstResponse.resolve();
    await expect(first).resolves.toBe('first');
    await expect(harness.coordinator.runExclusiveForeground(secondOperation)).resolves.toBe('second');
    expect(secondOperation).toHaveBeenCalledOnce();
  });

  it('does not let an old direct failure retry over a newer successful registration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youyu-traffic-registration-race-'));
    const firstDirectResponse = deferred<Response>();
    const allowTemporaryRuntime = deferred<void>();
    let runtimeAvailable = false;
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => firstDirectResponse.promise)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            userId: 'new-user',
            deviceId: 'new-device',
            name: 'Bob',
            traffic: {
              totalUpload: 0,
              totalDownload: 0,
              todayUpload: 0,
              todayDownload: 0,
              date: '2026-08-01'
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            userId: 'old-user',
            deviceId: 'old-device',
            name: 'Alice',
            traffic: {
              totalUpload: 0,
              totalDownload: 0,
              todayUpload: 0,
              todayDownload: 0,
              date: '2026-08-01'
            }
          }),
          { status: 200 }
        )
      );
    const store = new TrafficStore(directory);
    const reporter = new TrafficReporter({
      store,
      endpoint: 'https://traffic.example.com',
      appVersion: '1.6.9',
      fetch
    });
    const releaseTemporaryRuntime = vi.fn(async () => {
      runtimeAvailable = false;
    });
    const acquireTemporaryRuntime = vi.fn(async () => {
      await allowTemporaryRuntime.promise;
      runtimeAvailable = true;
      return releaseTemporaryRuntime;
    });
    const coordinator = createTrafficRegistrationCoordinator({
      reporter,
      store,
      hasSubscription: async () => true,
      acquireTemporaryRuntime,
      stopRuntime: async () => undefined,
      getProxyUrl: () => (runtimeAvailable ? 'http://127.0.0.1:7890' : undefined)
    });

    try {
      const first = coordinator.register({ name: 'Alice', passphrase: 'old-secret' });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      firstDirectResponse.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      await vi.waitFor(() => expect(acquireTemporaryRuntime).toHaveBeenCalledOnce());

      await expect(coordinator.register({ name: 'Bob', passphrase: 'new-secret' })).resolves.toEqual({
        committed: true
      });
      allowTemporaryRuntime.resolve();

      await expect(first).rejects.toThrow('本次流量登记已被较新的操作取代');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(releaseTemporaryRuntime).toHaveBeenCalledOnce();
      await expect(store.getSnapshot()).resolves.toMatchObject({
        identity: { userId: 'new-user', deviceId: 'new-device', name: 'Bob' }
      });
    } finally {
      allowTemporaryRuntime.resolve();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('skips pending activation while a foreground registration is in flight', async () => {
    const foregroundResponse = deferred<void>();
    let calls = 0;
    const harness = createHarness({
      pending: input,
      register: async () => {
        calls += 1;
        if (calls === 1) await foregroundResponse.promise;
      }
    });

    const foreground = harness.coordinator.runExclusiveForeground(() =>
      harness.coordinator.register({ name: 'Bob', passphrase: 'new-secret' })
    );
    await vi.waitFor(() => expect(harness.register).toHaveBeenCalledOnce());

    await expect(harness.coordinator.activatePending()).resolves.toBe(false);
    expect(harness.register).toHaveBeenCalledOnce();
    expect(harness.getPendingRegistration).not.toHaveBeenCalled();

    foregroundResponse.resolve();
    await expect(foreground).resolves.toEqual({ committed: true });
  });

  it('abandons a pending snapshot when a foreground registration starts while it is loading', async () => {
    const pendingResponse = deferred<typeof input | undefined>();
    const harness = createHarness({
      register: async () => undefined,
      getPendingRegistration: () => pendingResponse.promise
    });

    const pendingActivation = harness.coordinator.activatePending();
    await vi.waitFor(() => expect(harness.getPendingRegistration).toHaveBeenCalledOnce());
    await expect(
      harness.coordinator.runExclusiveForeground(() =>
        harness.coordinator.register({ name: 'Bob', passphrase: 'new-secret' })
      )
    ).resolves.toEqual({ committed: true });
    pendingResponse.resolve(input);

    await expect(pendingActivation).resolves.toBe(false);
    expect(harness.register).toHaveBeenCalledOnce();
  });

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

  it('returns a post-commit warning when temporary runtime cleanup fails after registration succeeds', async () => {
    const harness = createHarness({
      register: async (proxyUrl) => {
        if (!proxyUrl) throw new Error('fetch failed');
      }
    });
    harness.releaseTemporaryRuntime.mockRejectedValueOnce(new Error('proxy restore failed'));

    await expect(harness.coordinator.register(input)).resolves.toMatchObject({
      committed: true,
      postCommitError: expect.objectContaining({ message: 'proxy restore failed' })
    });
    expect(harness.releaseTemporaryRuntime).toHaveBeenCalledOnce();
  });

  it('stores registration when the temporary runtime cannot start', async () => {
    const harness = createHarness({ register: async () => Promise.reject(new Error('fetch failed')) });
    harness.acquireTemporaryRuntime.mockRejectedValueOnce(new Error('mihomo failed'));

    await harness.coordinator.register(input);
    expect(harness.registerPendingIdentity).toHaveBeenCalledWith(input);
    expect(harness.releaseTemporaryRuntime).not.toHaveBeenCalled();
  });

  it('keeps the verified identity when a switch has no fallback subscription', async () => {
    const directError = new Error('fetch failed');
    const harness = createHarness({
      hasSubscription: false,
      register: async () => Promise.reject(directError)
    });

    await expect(harness.coordinator.register(input, { preserveExistingIdentity: true })).rejects.toBe(directError);
    expect(harness.registerPendingIdentity).not.toHaveBeenCalled();
    expect(harness.acquireTemporaryRuntime).not.toHaveBeenCalled();
  });

  it('keeps the verified identity when a switch cannot start the temporary runtime', async () => {
    const startError = new Error('mihomo failed');
    const harness = createHarness({ register: async () => Promise.reject(new Error('fetch failed')) });
    harness.acquireTemporaryRuntime.mockRejectedValueOnce(startError);

    await expect(harness.coordinator.register(input, { preserveExistingIdentity: true })).rejects.toBe(startError);
    expect(harness.registerPendingIdentity).not.toHaveBeenCalled();
    expect(harness.releaseTemporaryRuntime).not.toHaveBeenCalled();
  });

  it('keeps the verified identity when a switch proxy retry fails transiently', async () => {
    const proxyError = new Error('traffic request timed out');
    const harness = createHarness({
      register: async (proxyUrl) => {
        if (!proxyUrl) throw new Error('fetch failed');
        throw proxyError;
      }
    });

    await expect(harness.coordinator.register(input, { preserveExistingIdentity: true })).rejects.toBe(proxyError);
    expect(harness.registerPendingIdentity).not.toHaveBeenCalled();
    expect(harness.releaseTemporaryRuntime).toHaveBeenCalledOnce();
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
