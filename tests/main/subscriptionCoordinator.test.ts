import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSubscriptionCoordinator,
  type SubscriptionCoordinatorSnapshot
} from '../../src/main/subscriptionCoordinator';

type TestRequest = { label: string };

function makeSnapshot(overrides: Partial<SubscriptionCoordinatorSnapshot> = {}): SubscriptionCoordinatorSnapshot {
  return {
    subscriptionUrl: 'https://example.com/sub-a',
    subscriptionRevision: 0,
    remoteRevision: 'identity-a:remote-1',
    subscriptionIntervalMs: 60_000,
    remoteIntervalMs: 180_000,
    subscriptionEnabled: true,
    remoteEnabled: true,
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

describe('createSubscriptionCoordinator', () => {
  it('starts with a real remote refresh, schedules both unref timers, and reschedules recurring work', async () => {
    vi.useFakeTimers();
    let snapshot = makeSnapshot({ subscriptionIntervalMs: 1_000, remoteIntervalMs: 2_000 });
    const refreshRemote = vi.fn(async () => undefined);
    const refreshSubscription = vi.fn(async () => undefined);
    const coordinator = createSubscriptionCoordinator<TestRequest, TestRequest>({
      readSnapshot: async () => snapshot,
      refreshRemote,
      refreshSubscription
    });

    await coordinator.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshRemote).toHaveBeenCalledOnce();
    expect(refreshSubscription).not.toHaveBeenCalled();
    expect(coordinator.inspect().timers.remote?.hasRef?.()).toBe(false);
    expect(coordinator.inspect().timers.subscription?.hasRef?.()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshSubscription).toHaveBeenCalledOnce();

    snapshot = { ...snapshot, subscriptionRevision: 1 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshRemote).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('does not let an older delayed reschedule overwrite a newer interval', async () => {
    vi.useFakeTimers();
    const firstRead = deferred<SubscriptionCoordinatorSnapshot>();
    const secondRead = deferred<SubscriptionCoordinatorSnapshot>();
    const refreshSubscription = vi.fn(async () => undefined);
    const readSnapshot = vi
      .fn<() => Promise<SubscriptionCoordinatorSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ subscriptionIntervalMs: 10_000, remoteEnabled: false }))
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise)
      .mockResolvedValue(makeSnapshot({ subscriptionIntervalMs: 2_000, remoteEnabled: false }));
    const coordinator = createSubscriptionCoordinator({
      readSnapshot,
      refreshRemote: async () => undefined,
      refreshSubscription,
      refreshRemoteOnStart: false
    });
    await coordinator.start();

    const older = coordinator.reschedule();
    const newer = coordinator.reschedule();
    secondRead.resolve(makeSnapshot({ subscriptionIntervalMs: 2_000, remoteEnabled: false }));
    await newer;
    firstRead.resolve(makeSnapshot({ subscriptionIntervalMs: 500, remoteEnabled: false }));
    await older;

    await vi.advanceTimersByTimeAsync(1_999);
    expect(refreshSubscription).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshSubscription).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it('does not start work from an older delayed preflight snapshot', async () => {
    const delayedOldRead = deferred<SubscriptionCoordinatorSnapshot>();
    let current = makeSnapshot();
    const readSnapshot = vi
      .fn<() => Promise<SubscriptionCoordinatorSnapshot>>()
      .mockResolvedValueOnce(current)
      .mockImplementationOnce(() => delayedOldRead.promise)
      .mockImplementation(async () => current);
    const refreshSubscription = vi.fn(async () => undefined);
    const coordinator = createSubscriptionCoordinator({
      readSnapshot,
      refreshRemote: async () => undefined,
      refreshSubscription,
      refreshRemoteOnStart: false
    });
    await coordinator.start();

    const refresh = coordinator.refresh('subscription', { source: 'manual' });
    await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(2));
    current = makeSnapshot({
      subscriptionUrl: 'https://example.com/sub-b',
      remoteRevision: 'identity-a:remote-2'
    });
    await coordinator.reschedule();
    delayedOldRead.resolve(makeSnapshot());

    await expect(refresh).resolves.toMatchObject({ applied: true });
    expect(refreshSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({ subscriptionUrl: 'https://example.com/sub-b' })
      })
    );
    coordinator.dispose();
  });

  it('skips timer work when the latest snapshot disables that background operation', async () => {
    vi.useFakeTimers();
    let snapshot = makeSnapshot({ subscriptionIntervalMs: 100, remoteEnabled: false });
    const refreshSubscription = vi.fn(async () => undefined);
    const coordinator = createSubscriptionCoordinator({
      readSnapshot: async () => snapshot,
      refreshRemote: async () => undefined,
      refreshSubscription,
      refreshRemoteOnStart: false
    });
    await coordinator.start();
    snapshot = { ...snapshot, subscriptionEnabled: false };

    await vi.advanceTimersByTimeAsync(100);

    expect(refreshSubscription).not.toHaveBeenCalled();
    expect(coordinator.inspect().timers.subscription).toBeUndefined();
    coordinator.dispose();
  });

  it('invalidates a delayed subscription result after the URL and remote revision change', async () => {
    let snapshot = makeSnapshot();
    const oldRefresh = deferred<void>();
    const onSubscriptionSuccess = vi.fn();
    const refreshSubscription = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await oldRefresh.promise;
      signal.throwIfAborted();
    });
    const coordinator = createSubscriptionCoordinator({
      readSnapshot: async () => snapshot,
      refreshRemote: async () => undefined,
      refreshSubscription,
      onSubscriptionSuccess,
      refreshRemoteOnStart: false
    });
    await coordinator.start();

    const running = coordinator.refresh('subscription', { source: 'manual' });
    await vi.waitFor(() => expect(refreshSubscription).toHaveBeenCalledOnce());
    snapshot = makeSnapshot({
      subscriptionUrl: 'https://example.com/sub-b',
      remoteRevision: 'identity-a:remote-2'
    });
    await coordinator.reschedule();
    oldRefresh.resolve();

    await expect(running).rejects.toThrow('subscription coordinator generation changed');
    expect(onSubscriptionSuccess).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it.each(['stop', 'dispose'] as const)(
    'does not publish or report success when %s wins while the success hook is waiting',
    async (halt) => {
      const successStarted = deferred<void>();
      const releaseSuccess = deferred<void>();
      const published: string[] = [];
      let hookSignal: AbortSignal | undefined;
      const coordinator = createSubscriptionCoordinator({
        readSnapshot: async () => makeSnapshot(),
        refreshRemote: async () => undefined,
        refreshSubscription: async () => 'refreshed',
        async onSubscriptionSuccess(_result, context) {
          hookSignal = context.signal;
          successStarted.resolve();
          await releaseSuccess.promise;
          context.signal.throwIfAborted();
          published.push('snapshot');
        },
        refreshRemoteOnStart: false
      });
      await coordinator.start();

      const running = coordinator.refresh('subscription', { source: 'background' });
      await successStarted.promise;
      coordinator[halt]();
      expect(hookSignal?.aborted).toBe(true);
      releaseSuccess.resolve();

      await expect(running).rejects.toThrow(`subscription coordinator ${halt === 'stop' ? 'stopped' : 'disposed'}`);
      expect(published).toEqual([]);
      if (halt === 'stop') coordinator.dispose();
    }
  );

  it('lets a manual refresh replace a background request and singleflights concurrent manual callers', async () => {
    const background = deferred<void>();
    const manual = deferred<void>();
    const calls: string[] = [];
    const refreshSubscription = vi.fn(
      async ({ source, signal }: { source: string; signal: AbortSignal; request?: TestRequest }) => {
        calls.push(source);
        if (source === 'background') {
          await Promise.race([
            background.promise,
            new Promise<never>((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            )
          ]);
          return;
        }
        await manual.promise;
      }
    );
    const coordinator = createSubscriptionCoordinator<TestRequest, TestRequest>({
      readSnapshot: async () => makeSnapshot(),
      refreshRemote: async () => undefined,
      refreshSubscription,
      refreshRemoteOnStart: false
    });
    await coordinator.start();
    const backgroundRun = coordinator.refresh('subscription', { source: 'background' });
    await vi.waitFor(() => expect(calls).toEqual(['background']));

    const firstManual = coordinator.refresh('subscription', {
      source: 'manual',
      request: { label: 'manual-a' }
    });
    const secondManual = coordinator.refresh('subscription', {
      source: 'manual',
      request: { label: 'manual-b' }
    });
    await expect(backgroundRun).rejects.toThrow('superseded by manual refresh');
    await vi.waitFor(() => expect(calls).toEqual(['background', 'manual']));
    manual.resolve();

    await expect(Promise.all([firstManual, secondManual])).resolves.toMatchObject([
      { applied: true, source: 'manual' },
      { applied: true, source: 'manual' }
    ]);
    expect(refreshSubscription).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('keeps remote and subscription operation keys independent', async () => {
    const remote = deferred<void>();
    const subscription = deferred<void>();
    const refreshRemote = vi.fn(async () => remote.promise);
    const refreshSubscription = vi.fn(async () => subscription.promise);
    const coordinator = createSubscriptionCoordinator({
      readSnapshot: async () => makeSnapshot(),
      refreshRemote,
      refreshSubscription,
      refreshRemoteOnStart: false
    });
    await coordinator.start();

    const remoteRun = coordinator.refresh('remote', { source: 'manual' });
    const subscriptionRun = coordinator.refresh('subscription', { source: 'manual' });
    await vi.waitFor(() => {
      expect(refreshRemote).toHaveBeenCalledOnce();
      expect(refreshSubscription).toHaveBeenCalledOnce();
    });
    remote.resolve();
    subscription.resolve();

    await expect(Promise.all([remoteRun, subscriptionRun])).resolves.toMatchObject([
      { applied: true, kind: 'remote' },
      { applied: true, kind: 'subscription' }
    ]);
    coordinator.dispose();
  });

  it('aborts both keys on stop, clears timers, and can start again', async () => {
    vi.useFakeTimers();
    const aborts: string[] = [];
    const waitForAbort = ({ kind, signal }: { kind: string; signal: AbortSignal }) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborts.push(kind);
            reject(signal.reason);
          },
          { once: true }
        );
      });
    const coordinator = createSubscriptionCoordinator({
      readSnapshot: async () => makeSnapshot({ subscriptionIntervalMs: 1_000, remoteIntervalMs: 1_000 }),
      refreshRemote: waitForAbort,
      refreshSubscription: waitForAbort,
      refreshRemoteOnStart: false
    });
    await coordinator.start();
    const remote = coordinator.refresh('remote', { source: 'manual' });
    const subscription = coordinator.refresh('subscription', { source: 'manual' });
    await vi.waitFor(() => expect(coordinator.inspect().active).toEqual(['remote', 'subscription']));

    coordinator.stop();

    await expect(remote).rejects.toThrow('subscription coordinator stopped');
    await expect(subscription).rejects.toThrow('subscription coordinator stopped');
    expect(aborts.sort()).toEqual(['remote', 'subscription']);
    expect(coordinator.inspect().timers).toEqual({});

    await coordinator.start();
    expect(coordinator.inspect().started).toBe(true);
    coordinator.dispose();
  });

  it('still performs the startup remote refresh when the snapshot changed while stopped', async () => {
    let snapshot = makeSnapshot();
    const refreshRemote = vi.fn(async () => undefined);
    const coordinator = createSubscriptionCoordinator({
      readSnapshot: async () => snapshot,
      refreshRemote,
      refreshSubscription: async () => undefined
    });
    await coordinator.start();
    await vi.waitFor(() => expect(refreshRemote).toHaveBeenCalledOnce());
    coordinator.stop();

    snapshot = makeSnapshot({
      subscriptionUrl: 'https://example.com/sub-b',
      remoteRevision: 'identity-b:remote-1'
    });
    await coordinator.start();

    await vi.waitFor(() => expect(refreshRemote).toHaveBeenCalledTimes(2));
    coordinator.dispose();
  });

  it('disposes permanently and rejects later start or refresh calls', async () => {
    const coordinator = createSubscriptionCoordinator({
      readSnapshot: async () => makeSnapshot(),
      refreshRemote: async () => undefined,
      refreshSubscription: async () => undefined,
      refreshRemoteOnStart: false
    });
    await coordinator.start();
    coordinator.dispose();

    await expect(coordinator.start()).rejects.toThrow('subscription coordinator disposed');
    await expect(coordinator.refresh('remote', { source: 'manual' })).rejects.toThrow(
      'subscription coordinator disposed'
    );
  });

  it('recovers from an operation exception and allows a later retry', async () => {
    const refreshSubscription = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary provider failure'))
      .mockResolvedValueOnce(undefined);
    const coordinator = createSubscriptionCoordinator({
      readSnapshot: async () => makeSnapshot(),
      refreshRemote: async () => undefined,
      refreshSubscription,
      refreshRemoteOnStart: false
    });
    await coordinator.start();

    await expect(coordinator.refresh('subscription', { source: 'manual' })).rejects.toThrow(
      'temporary provider failure'
    );
    await expect(coordinator.refresh('subscription', { source: 'manual' })).resolves.toMatchObject({
      applied: true
    });
    expect(refreshSubscription).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('aborts an old subscription request when a remote success changes the effective subscription snapshot', async () => {
    let snapshot = makeSnapshot();
    const subscriptionStarted = deferred<void>();
    const subscriptionAborted = deferred<unknown>();
    const refreshSubscription = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      subscriptionStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            subscriptionAborted.resolve(signal.reason);
            reject(signal.reason);
          },
          { once: true }
        );
      });
    });
    const refreshRemote = vi.fn(async () => {
      snapshot = makeSnapshot({
        subscriptionUrl: 'https://example.com/sub-b',
        remoteRevision: 'identity-a:remote-2',
        subscriptionIntervalMs: 2_000
      });
    });
    const coordinator = createSubscriptionCoordinator({
      readSnapshot: async () => snapshot,
      refreshRemote,
      refreshSubscription,
      refreshRemoteOnStart: false
    });
    await coordinator.start();
    const oldSubscription = coordinator.refresh('subscription', { source: 'background' });
    await subscriptionStarted.promise;

    await expect(coordinator.refresh('remote', { source: 'manual' })).resolves.toMatchObject({ applied: true });

    await expect(subscriptionAborted.promise).resolves.toMatchObject({
      message: 'subscription coordinator generation changed'
    });
    await expect(oldSubscription).rejects.toThrow('subscription coordinator generation changed');
    expect(coordinator.inspect().snapshot?.subscriptionUrl).toBe('https://example.com/sub-b');
    coordinator.dispose();
  });
});
