export type SubscriptionOperationKind = 'remote' | 'subscription';
export type SubscriptionRefreshSource = 'background' | 'manual' | 'startup' | 'system';

export type SubscriptionCoordinatorSnapshot = {
  subscriptionUrl: string;
  subscriptionRevision: string | number;
  remoteRevision: string;
  subscriptionIntervalMs: number;
  remoteIntervalMs: number;
  subscriptionEnabled: boolean;
  remoteEnabled: boolean;
};

export type SubscriptionRefreshContext<Request> = {
  kind: SubscriptionOperationKind;
  source: SubscriptionRefreshSource;
  signal: AbortSignal;
  generation: number;
  snapshot: Readonly<SubscriptionCoordinatorSnapshot>;
  request?: Request;
};

export type SubscriptionRefreshResult<Value = unknown> = {
  kind: SubscriptionOperationKind;
  source: SubscriptionRefreshSource;
  generation: number;
  applied: boolean;
  value?: Value;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type ActiveOperation = {
  id: symbol;
  kind: SubscriptionOperationKind;
  source: SubscriptionRefreshSource;
  generation: number;
  snapshot: Readonly<SubscriptionCoordinatorSnapshot>;
  controller: AbortController;
  promise: Promise<SubscriptionRefreshResult>;
};

type RefreshOptions<Request> = {
  source?: SubscriptionRefreshSource;
  signal?: AbortSignal;
  request?: Request;
};

type SubscriptionCoordinatorOptions<RemoteRequest, SubscriptionRequest, RemoteValue, SubscriptionValue> = {
  readSnapshot: () => Promise<SubscriptionCoordinatorSnapshot>;
  refreshRemote: (context: SubscriptionRefreshContext<RemoteRequest>) => Promise<RemoteValue>;
  refreshSubscription: (context: SubscriptionRefreshContext<SubscriptionRequest>) => Promise<SubscriptionValue>;
  onRemoteSuccess?: (result: RemoteValue, context: SubscriptionRefreshContext<RemoteRequest>) => void | Promise<void>;
  onSubscriptionSuccess?: (
    result: SubscriptionValue,
    context: SubscriptionRefreshContext<SubscriptionRequest>
  ) => void | Promise<void>;
  onBackgroundError?: (kind: SubscriptionOperationKind, error: unknown) => void | Promise<void>;
  refreshRemoteOnStart?: boolean;
};

export function createSubscriptionCoordinator<
  RemoteRequest = void,
  SubscriptionRequest = void,
  RemoteValue = unknown,
  SubscriptionValue = unknown
>(options: SubscriptionCoordinatorOptions<RemoteRequest, SubscriptionRequest, RemoteValue, SubscriptionValue>) {
  let started = false;
  let disposed = false;
  let generation = 0;
  let lifecycleEpoch = 0;
  let rescheduleRequest = 0;
  let startPromise: Promise<void> | undefined;
  let snapshot: SubscriptionCoordinatorSnapshot | undefined;
  let latestSnapshotRead: Promise<SubscriptionCoordinatorSnapshot> | undefined;
  const scheduleEpoch: Record<SubscriptionOperationKind, number> = { remote: 0, subscription: 0 };
  const timers: Partial<Record<SubscriptionOperationKind, TimerHandle>> = {};
  const active: Partial<Record<SubscriptionOperationKind, ActiveOperation>> = {};

  function assertAvailable(): void {
    if (disposed) throw new Error('subscription coordinator disposed');
    if (!started) throw new Error('subscription coordinator stopped');
  }

  function assertOperationOwned(operation: ActiveOperation): void {
    operation.controller.signal.throwIfAborted();
    if (!started || disposed || active[operation.kind]?.id !== operation.id) {
      throw operation.controller.signal.reason ?? new Error('subscription coordinator operation is stale');
    }
  }

  function normalizeSnapshot(value: SubscriptionCoordinatorSnapshot): SubscriptionCoordinatorSnapshot {
    return {
      subscriptionUrl: value.subscriptionUrl.trim(),
      subscriptionRevision: String(value.subscriptionRevision),
      remoteRevision: String(value.remoteRevision),
      subscriptionIntervalMs: normalizeInterval(value.subscriptionIntervalMs),
      remoteIntervalMs: normalizeInterval(value.remoteIntervalMs),
      subscriptionEnabled: Boolean(value.subscriptionEnabled),
      remoteEnabled: Boolean(value.remoteEnabled)
    };
  }

  async function readLatestSnapshot(): Promise<SubscriptionCoordinatorSnapshot> {
    let pending = Promise.resolve()
      .then(() => options.readSnapshot())
      .then(normalizeSnapshot);
    latestSnapshotRead = pending;
    while (true) {
      try {
        const value = await pending;
        if (pending === latestSnapshotRead) return value;
      } catch (error) {
        if (pending === latestSnapshotRead) throw error;
      }
      pending = latestSnapshotRead;
    }
  }

  function clearTimer(kind: SubscriptionOperationKind): void {
    const timer = timers[kind];
    if (!timer) return;
    clearTimeout(timer);
    delete timers[kind];
    scheduleEpoch[kind] += 1;
  }

  function clearAllTimers(): void {
    clearTimer('remote');
    clearTimer('subscription');
  }

  function abortOperation(kind: SubscriptionOperationKind, reason: Error, preserve?: ActiveOperation): void {
    const operation = active[kind];
    if (!operation || operation === preserve || operation.controller.signal.aborted) return;
    operation.controller.abort(reason);
  }

  function abortAll(reason: Error, preserve?: ActiveOperation): void {
    abortOperation('remote', reason, preserve);
    abortOperation('subscription', reason, preserve);
  }

  function fundamentalRevision(value: SubscriptionCoordinatorSnapshot): string {
    return `${value.subscriptionUrl}\u0000${value.remoteRevision}`;
  }

  function subscriptionOperationRevision(value: SubscriptionCoordinatorSnapshot): string {
    return `${fundamentalRevision(value)}\u0000${value.subscriptionRevision}`;
  }

  function enabledFor(kind: SubscriptionOperationKind, value: SubscriptionCoordinatorSnapshot): boolean {
    return kind === 'remote' ? value.remoteEnabled : value.subscriptionEnabled;
  }

  function intervalFor(kind: SubscriptionOperationKind, value: SubscriptionCoordinatorSnapshot): number {
    return kind === 'remote' ? value.remoteIntervalMs : value.subscriptionIntervalMs;
  }

  function scheduleChanged(
    kind: SubscriptionOperationKind,
    previous: SubscriptionCoordinatorSnapshot,
    next: SubscriptionCoordinatorSnapshot
  ): boolean {
    return (
      enabledFor(kind, previous) !== enabledFor(kind, next) || intervalFor(kind, previous) !== intervalFor(kind, next)
    );
  }

  function scheduleTimer(kind: SubscriptionOperationKind): void {
    if (!started || disposed || timers[kind] || active[kind] || !snapshot || !enabledFor(kind, snapshot)) return;
    const intervalMs = intervalFor(kind, snapshot);
    if (intervalMs <= 0) return;
    const scheduledGeneration = generation;
    const scheduledEpoch = ++scheduleEpoch[kind];
    const timer = setTimeout(() => {
      if (timers[kind] === timer) delete timers[kind];
      if (!started || disposed || scheduledGeneration !== generation || scheduledEpoch !== scheduleEpoch[kind]) {
        return;
      }
      void refresh(kind, { source: 'background' }).catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
    timers[kind] = timer;
  }

  function scheduleAll(): void {
    scheduleTimer('remote');
    scheduleTimer('subscription');
  }

  async function adoptSnapshot(nextValue: SubscriptionCoordinatorSnapshot, preserve?: ActiveOperation): Promise<void> {
    if (!started || disposed) return;
    const next = normalizeSnapshot(nextValue);
    const previous = snapshot;
    if (!previous) {
      snapshot = next;
      clearAllTimers();
      scheduleAll();
      return;
    }

    const fundamentalChanged = fundamentalRevision(previous) !== fundamentalRevision(next);
    const subscriptionRevisionChanged = previous.subscriptionRevision !== next.subscriptionRevision;
    if (fundamentalChanged) {
      generation += 1;
      clearAllTimers();
      abortAll(new Error('subscription coordinator generation changed'), preserve);
    } else {
      if (scheduleChanged('remote', previous, next)) clearTimer('remote');
      if (scheduleChanged('subscription', previous, next) || subscriptionRevisionChanged) {
        clearTimer('subscription');
        if (subscriptionRevisionChanged) {
          abortOperation('subscription', new Error('subscription revision changed'), preserve);
        }
      }
    }
    snapshot = next;
    scheduleAll();
  }

  async function reschedule(): Promise<void> {
    if (disposed) throw new Error('subscription coordinator disposed');
    if (!started) return;
    const request = ++rescheduleRequest;
    const next = await readLatestSnapshot();
    if (!started || disposed || request !== rescheduleRequest) return;
    await adoptSnapshot(next);
  }

  async function start(): Promise<void> {
    if (disposed) throw new Error('subscription coordinator disposed');
    if (started) return startPromise;
    started = true;
    generation += 1;
    const startEpoch = ++lifecycleEpoch;
    let pending!: Promise<void>;
    pending = (async () => {
      try {
        await reschedule();
        if (!started || disposed || lifecycleEpoch !== startEpoch || options.refreshRemoteOnStart === false) return;
        if (snapshot?.remoteEnabled) {
          void refresh('remote', { source: 'background' }).catch(() => undefined);
        }
      } catch (error) {
        if (lifecycleEpoch === startEpoch) {
          started = false;
          clearAllTimers();
        }
        throw error;
      } finally {
        if (startPromise === pending) startPromise = undefined;
      }
    })();
    startPromise = pending;
    return pending;
  }

  function halt(reason: Error): void {
    if (!started) return;
    started = false;
    generation += 1;
    lifecycleEpoch += 1;
    rescheduleRequest += 1;
    clearAllTimers();
    abortAll(reason);
  }

  function stop(): void {
    halt(new Error('subscription coordinator stopped'));
  }

  function dispose(): void {
    if (disposed) return;
    halt(new Error('subscription coordinator disposed'));
    disposed = true;
    snapshot = undefined;
  }

  async function refresh(
    kind: 'remote',
    refreshOptions?: RefreshOptions<RemoteRequest>
  ): Promise<SubscriptionRefreshResult<RemoteValue>>;
  async function refresh(
    kind: 'subscription',
    refreshOptions?: RefreshOptions<SubscriptionRequest>
  ): Promise<SubscriptionRefreshResult<SubscriptionValue>>;
  async function refresh(
    kind: SubscriptionOperationKind,
    refreshOptions?: RefreshOptions<RemoteRequest | SubscriptionRequest>
  ): Promise<SubscriptionRefreshResult<RemoteValue | SubscriptionValue>>;
  async function refresh(
    kind: SubscriptionOperationKind,
    refreshOptions: RefreshOptions<RemoteRequest | SubscriptionRequest> = {}
  ): Promise<SubscriptionRefreshResult> {
    assertAvailable();
    refreshOptions.signal?.throwIfAborted();
    const latest = await readLatestSnapshot();
    assertAvailable();
    refreshOptions.signal?.throwIfAborted();
    await adoptSnapshot(latest);

    const source = refreshOptions.source ?? 'manual';
    if (source === 'background' && snapshot && !enabledFor(kind, snapshot)) {
      return { kind, source, generation, applied: false };
    }
    const existing = active[kind];
    if (existing) {
      if (existing.controller.signal.aborted) {
        await existing.promise.catch(() => undefined);
        refreshOptions.signal?.throwIfAborted();
        assertAvailable();
        return refresh(kind as never, refreshOptions as never);
      }
      const replacesBackground = source !== 'background' && existing.source === 'background';
      if (!replacesBackground) {
        return observeWithSignal(existing.promise, refreshOptions.signal);
      }
      existing.controller.abort(new Error(`${kind} refresh superseded by manual refresh`));
      await existing.promise.catch(() => undefined);
      refreshOptions.signal?.throwIfAborted();
      assertAvailable();
      return refresh(kind as never, refreshOptions as never);
    }

    clearTimer(kind);
    const operationSnapshot = snapshot;
    if (!operationSnapshot) throw new Error('subscription coordinator snapshot unavailable');
    const controller = new AbortController();
    const unlinkSignal = linkAbortSignal(refreshOptions.signal, controller);
    const operation: ActiveOperation = {
      id: Symbol(kind),
      kind,
      source,
      generation,
      snapshot: operationSnapshot,
      controller,
      promise: Promise.resolve(undefined as never)
    };
    const context: SubscriptionRefreshContext<RemoteRequest | SubscriptionRequest> = {
      kind,
      source,
      signal: controller.signal,
      generation: operation.generation,
      snapshot: operationSnapshot,
      request: refreshOptions.request
    };
    const promise = executeOperation(operation, context).finally(() => {
      unlinkSignal();
      if (active[kind]?.id === operation.id) {
        delete active[kind];
        scheduleTimer(kind);
      }
    });
    operation.promise = promise;
    active[kind] = operation;
    return observeWithSignal(promise, refreshOptions.signal);
  }

  async function executeOperation(
    operation: ActiveOperation,
    context: SubscriptionRefreshContext<RemoteRequest | SubscriptionRequest>
  ): Promise<SubscriptionRefreshResult> {
    try {
      const value =
        operation.kind === 'remote'
          ? await options.refreshRemote(context as SubscriptionRefreshContext<RemoteRequest>)
          : await options.refreshSubscription(context as SubscriptionRefreshContext<SubscriptionRequest>);
      operation.controller.signal.throwIfAborted();
      if (!started || disposed || active[operation.kind]?.id !== operation.id) {
        throw new Error('subscription coordinator generation changed');
      }
      if (operation.generation !== generation) {
        throw new Error('subscription coordinator generation changed');
      }

      const afterOperation = await readLatestSnapshot();
      operation.controller.signal.throwIfAborted();
      if (operation.generation !== generation) {
        throw new Error('subscription coordinator generation changed');
      }
      const subscriptionResultIsCurrent =
        operation.kind === 'remote' ||
        subscriptionOperationRevision(operation.snapshot) === subscriptionOperationRevision(afterOperation);
      await adoptSnapshot(afterOperation, operation);
      assertOperationOwned(operation);
      if (!subscriptionResultIsCurrent) {
        return {
          kind: operation.kind,
          source: operation.source,
          generation: operation.generation,
          applied: false
        };
      }

      if (operation.kind === 'remote') {
        await options.onRemoteSuccess?.(value as RemoteValue, context as SubscriptionRefreshContext<RemoteRequest>);
      } else {
        await options.onSubscriptionSuccess?.(
          value as SubscriptionValue,
          context as SubscriptionRefreshContext<SubscriptionRequest>
        );
      }
      assertOperationOwned(operation);
      const finalSnapshot = await readLatestSnapshot();
      assertOperationOwned(operation);
      await adoptSnapshot(finalSnapshot, operation);
      assertOperationOwned(operation);
      return {
        kind: operation.kind,
        source: operation.source,
        generation: operation.generation,
        applied: true,
        value
      };
    } catch (error) {
      const reportedError = operation.controller.signal.aborted ? operation.controller.signal.reason : error;
      if (operation.source === 'background' && !operation.controller.signal.aborted) {
        try {
          await options.onBackgroundError?.(operation.kind, reportedError);
        } catch {
          // Error reporting must not replace the operation's original failure.
        }
      }
      throw reportedError;
    }
  }

  return {
    start,
    reschedule,
    refresh,
    stop,
    dispose,
    inspect() {
      return {
        started,
        disposed,
        generation,
        snapshot: snapshot ? { ...snapshot } : undefined,
        active: (['remote', 'subscription'] as const).filter((kind) => Boolean(active[kind])),
        timers: { ...timers }
      };
    }
  };
}

function normalizeInterval(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.floor(value));
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener('abort', abort);
}

function observeWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}
