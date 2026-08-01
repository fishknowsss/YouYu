import type { CurrentNodeHealth, NodeAvailabilitySnapshot, ProxyNode } from '../shared/ipc';
import { createEmptyCurrentNodeHealth } from './storage/nodeHealth';

export type NodeHealthContext = {
  nodeName: string;
  running: boolean;
  direct: boolean;
  revision: string | number;
};

type NodeHealthCoordinatorOptions<Context extends NodeHealthContext, AvailabilityRecord> = {
  totalAvailabilityCount: number;
  initialDelayMs: number;
  intervalMs: number;
  retryDelayMs: number;
  failureThreshold: number;
  readContext: () => Promise<Context>;
  probeDelay: (context: Readonly<Context>, signal: AbortSignal) => Promise<number | undefined>;
  recoverNode?: (context: Readonly<Context>, signal: AbortSignal) => Promise<string | undefined>;
  onTransientFailure?: (nodeName: string, failureCount: number) => void | Promise<void>;
  onRecovering?: (nodeName: string) => void | Promise<void>;
  onRecovered?: (nodeName: string, signal: AbortSignal) => void | Promise<void>;
  onBackgroundError?: (error: unknown) => void | Promise<void>;
  onHealthChanged?: (health: CurrentNodeHealth) => void | Promise<void>;
  readCachedAvailability?: (nodeName: string) => Promise<AvailabilityRecord | undefined>;
  probeAvailability?: (context: Readonly<Context>, signal: AbortSignal) => Promise<AvailabilityRecord>;
  saveAvailability?: (
    record: AvailabilityRecord,
    operation: {
      context: Readonly<Context>;
      signal: AbortSignal;
      isCurrent: () => boolean;
    }
  ) => Promise<boolean | void>;
  toAvailabilitySnapshot?: (record: AvailabilityRecord) => NodeAvailabilitySnapshot;
  onAvailabilityError?: (error: unknown) => void | Promise<void>;
  now?: () => Date;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type ActiveDelayOperation = {
  id: symbol;
  generation: number;
  contextKey: string;
  controller: AbortController;
  promise: Promise<void>;
};

type ActiveAvailabilityOperation = {
  id: symbol;
  generation: number;
  contextKey: string;
  controller: AbortController;
  promise: Promise<void>;
};

export function createNodeHealthCoordinator<Context extends NodeHealthContext, AvailabilityRecord = never>(
  options: NodeHealthCoordinatorOptions<Context, AvailabilityRecord>
) {
  let started = false;
  let disposed = false;
  let generation = 0;
  let timer: TimerHandle | undefined;
  let timerEpoch = 0;
  let context: Context | undefined;
  let health = createEmptyCurrentNodeHealth('', options.totalAvailabilityCount);
  let activeDelay: ActiveDelayOperation | undefined;
  let activeAvailability: ActiveAvailabilityOperation | undefined;
  let latestContextRead: Promise<Context> | undefined;
  let failureCount = 0;
  let failureNodeName = '';

  function assertAvailable(): void {
    if (disposed) throw new Error('node health coordinator disposed');
    if (!started) throw new Error('node health coordinator stopped');
  }

  function keyOf(value: NodeHealthContext): string {
    return JSON.stringify([value.running, value.direct, value.nodeName.trim(), String(value.revision)]);
  }

  function usable(value: NodeHealthContext): boolean {
    const nodeName = value.nodeName.trim();
    return value.running && !value.direct && Boolean(nodeName) && nodeName !== 'DIRECT';
  }

  function cloneHealth(): CurrentNodeHealth {
    return { ...health, availability: { ...health.availability } };
  }

  function emitHealthChanged(): void {
    void Promise.resolve(options.onHealthChanged?.(cloneHealth())).catch(() => undefined);
  }

  async function readLatestContext(): Promise<Context> {
    let pending = Promise.resolve().then(options.readContext);
    latestContextRead = pending;
    while (true) {
      try {
        const value = await pending;
        if (pending === latestContextRead) return value;
      } catch (error) {
        if (pending === latestContextRead) throw error;
      }
      pending = latestContextRead;
    }
  }

  function clearTimer(): void {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
    timerEpoch += 1;
  }

  function detachDelay(reason: Error): void {
    const operation = activeDelay;
    if (!operation) return;
    activeDelay = undefined;
    operation.controller.abort(reason);
  }

  function detachAvailability(reason: Error): void {
    const operation = activeAvailability;
    if (!operation) return;
    activeAvailability = undefined;
    operation.controller.abort(reason);
  }

  function resetTestingState(): void {
    if (health.delayStatus !== 'testing' && health.availability.status !== 'testing') return;
    health = {
      ...health,
      ...(health.delayStatus === 'testing'
        ? { delayStatus: 'untested' as const, delay: undefined, delayCheckedAt: undefined }
        : {}),
      availability:
        health.availability.status === 'testing'
          ? { status: 'untested', totalCount: options.totalAvailabilityCount }
          : health.availability
    };
    emitHealthChanged();
  }

  function invalidate(reason: Error): void {
    generation += 1;
    clearTimer();
    detachDelay(reason);
    detachAvailability(reason);
    resetTestingState();
  }

  function adoptContext(next: Context): boolean {
    const normalized = { ...next, nodeName: next.nodeName.trim() };
    if (context && keyOf(context) === keyOf(normalized)) {
      context = normalized;
      return false;
    }
    invalidate(new Error('node health context changed'));
    context = normalized;
    health = createEmptyCurrentNodeHealth(normalized.nodeName, options.totalAvailabilityCount);
    failureCount = 0;
    failureNodeName = normalized.nodeName;
    emitHealthChanged();
    return true;
  }

  function transitionRecoveredContext(next: Context, operation: ActiveDelayOperation): void {
    generation += 1;
    clearTimer();
    detachAvailability(new Error('node health context recovered'));
    context = { ...next, nodeName: next.nodeName.trim() };
    operation.generation = generation;
    operation.contextKey = keyOf(context);
    health = createEmptyCurrentNodeHealth(context.nodeName, options.totalAvailabilityCount);
    failureCount = 0;
    failureNodeName = context.nodeName;
    emitHealthChanged();
  }

  async function verifyDelayOperation(operation: ActiveDelayOperation): Promise<void> {
    operation.controller.signal.throwIfAborted();
    if (!started || disposed || activeDelay?.id !== operation.id || operation.generation !== generation || !context) {
      throw new Error('node health operation is stale');
    }
    const latest = await readLatestContext();
    operation.controller.signal.throwIfAborted();
    if (keyOf(latest) !== operation.contextKey) {
      adoptContext(latest);
      scheduleTimer(0);
      throw operation.controller.signal.reason ?? new Error('node health operation is stale');
    }
  }

  function ownsDelayOperation(operation: ActiveDelayOperation): boolean {
    return activeDelay?.id === operation.id;
  }

  function isAvailabilityOperationCurrent(operation: ActiveAvailabilityOperation): boolean {
    return (
      started &&
      !disposed &&
      activeAvailability?.id === operation.id &&
      operation.generation === generation &&
      Boolean(context) &&
      operation.contextKey === keyOf(context as Context) &&
      !operation.controller.signal.aborted
    );
  }

  async function verifyAvailabilityOperation(operation: ActiveAvailabilityOperation): Promise<void> {
    operation.controller.signal.throwIfAborted();
    if (!isAvailabilityOperationCurrent(operation)) throw new Error('node availability operation is stale');
    const latest = await readLatestContext();
    operation.controller.signal.throwIfAborted();
    if (keyOf(latest) !== operation.contextKey) {
      adoptContext(latest);
      scheduleTimer(0);
      throw operation.controller.signal.reason ?? new Error('node availability operation is stale');
    }
  }

  function applyAvailability(record: AvailabilityRecord): void {
    if (!options.toAvailabilitySnapshot) return;
    health = { ...health, availability: options.toAvailabilitySnapshot(record) };
    emitHealthChanged();
  }

  function applyAvailabilityFailure(): void {
    health = {
      ...health,
      availability: { status: 'failed', totalCount: options.totalAvailabilityCount }
    };
    emitHealthChanged();
  }

  async function ensureAvailability(operationContext: Context): Promise<void> {
    if (
      !options.readCachedAvailability ||
      !options.probeAvailability ||
      !options.saveAvailability ||
      !options.toAvailabilitySnapshot
    ) {
      return;
    }
    if (!context || keyOf(context) !== keyOf(operationContext) || !usable(context)) return;
    if (activeAvailability) return activeAvailability.promise;

    const operation: ActiveAvailabilityOperation = {
      id: Symbol('node-health-availability'),
      generation,
      contextKey: keyOf(operationContext),
      controller: new AbortController(),
      promise: Promise.resolve()
    };
    const promise = (async () => {
      try {
        let cached: AvailabilityRecord | undefined;
        try {
          cached = await options.readCachedAvailability?.(operationContext.nodeName);
        } catch (error) {
          await options.onAvailabilityError?.(error);
        }
        await verifyAvailabilityOperation(operation);
        if (cached) {
          applyAvailability(cached);
          return;
        }

        health = {
          ...health,
          availability: { status: 'testing', totalCount: options.totalAvailabilityCount }
        };
        emitHealthChanged();
        const record = await options.probeAvailability?.(operationContext, operation.controller.signal);
        if (!record) throw new Error('node availability result missing');
        await verifyAvailabilityOperation(operation);
        const committed = await options.saveAvailability?.(record, {
          context: operationContext,
          signal: operation.controller.signal,
          isCurrent: () => isAvailabilityOperationCurrent(operation)
        });
        await verifyAvailabilityOperation(operation);
        if (committed === false) throw new Error('node availability commit became stale');
        applyAvailability(record);
      } catch (error) {
        if (operation.controller.signal.aborted || !isAvailabilityOperationCurrent(operation)) throw error;
        applyAvailabilityFailure();
        await options.onAvailabilityError?.(error);
      }
    })().finally(() => {
      if (activeAvailability?.id === operation.id) activeAvailability = undefined;
    });
    operation.promise = promise;
    activeAvailability = operation;
    return promise;
  }

  function scheduleTimer(delayMs: number): void {
    if (!started || disposed || timer) return;
    const delay = Math.max(0, Math.floor(delayMs));
    const scheduledGeneration = generation;
    const scheduledEpoch = ++timerEpoch;
    const scheduled = setTimeout(() => {
      if (timer === scheduled) timer = undefined;
      if (!started || disposed || scheduledGeneration !== generation || scheduledEpoch !== timerEpoch) return;
      void checkNow().catch(() => undefined);
    }, delay);
    scheduled.unref?.();
    timer = scheduled;
  }

  function start(): void {
    if (disposed) throw new Error('node health coordinator disposed');
    if (started) return;
    started = true;
    generation += 1;
    scheduleTimer(options.initialDelayMs);
  }

  function stop(): void {
    if (!started) return;
    started = false;
    invalidate(new Error('node health coordinator stopped'));
  }

  function dispose(): void {
    if (disposed) return;
    stop();
    disposed = true;
    context = undefined;
  }

  function reschedule(delayMs = options.intervalMs): void {
    if (disposed) throw new Error('node health coordinator disposed');
    if (!started) return;
    invalidate(new Error('node health check rescheduled'));
    scheduleTimer(delayMs);
  }

  function invalidateContext(): void {
    if (disposed) throw new Error('node health coordinator disposed');
    if (!started) return;
    invalidate(new Error('node health context invalidated'));
  }

  async function checkNow(): Promise<void> {
    assertAvailable();
    const invocationGeneration = generation;
    let latest: Context;
    try {
      latest = await readLatestContext();
    } catch (error) {
      if (!started || disposed || invocationGeneration !== generation) throw error;
      try {
        await options.onBackgroundError?.(error);
      } finally {
        if (started && !disposed && invocationGeneration === generation) {
          scheduleTimer(options.intervalMs);
        }
      }
      return;
    }
    assertAvailable();
    if (invocationGeneration !== generation) throw new Error('node health check invocation is stale');
    adoptContext(latest);
    if (!context || !usable(context)) {
      scheduleTimer(options.intervalMs);
      return;
    }
    if (activeDelay) return activeDelay.promise;

    clearTimer();
    const operationContext = context;
    const operation: ActiveDelayOperation = {
      id: Symbol('node-health-delay'),
      generation,
      contextKey: keyOf(operationContext),
      controller: new AbortController(),
      promise: Promise.resolve()
    };
    health = {
      ...health,
      nodeName: operationContext.nodeName,
      delayStatus: 'testing',
      delay: undefined,
      delayCheckedAt: undefined
    };
    emitHealthChanged();
    let nextDelayMs = options.intervalMs;
    const promise = (async () => {
      try {
        const delay = await options.probeDelay(operationContext, operation.controller.signal);
        await verifyDelayOperation(operation);
        if (typeof delay === 'number') {
          failureCount = 0;
          failureNodeName = operationContext.nodeName;
          health = {
            ...health,
            delayStatus: 'measured',
            delay,
            delayCheckedAt: (options.now?.() ?? new Date()).toISOString()
          };
          emitHealthChanged();
          void ensureAvailability(operationContext).catch(() => undefined);
          return;
        }

        health = {
          ...health,
          delayStatus: 'failed',
          delay: undefined,
          delayCheckedAt: (options.now?.() ?? new Date()).toISOString()
        };
        emitHealthChanged();
        if (failureNodeName !== operationContext.nodeName) {
          failureNodeName = operationContext.nodeName;
          failureCount = 0;
        }
        failureCount += 1;
        if (failureCount < options.failureThreshold) {
          nextDelayMs = options.retryDelayMs;
          await options.onTransientFailure?.(operationContext.nodeName, failureCount);
          await verifyDelayOperation(operation);
          return;
        }

        await options.onRecovering?.(operationContext.nodeName);
        await verifyDelayOperation(operation);
        const selectedNode = await options.recoverNode?.(operationContext, operation.controller.signal);
        operation.controller.signal.throwIfAborted();
        if (!selectedNode) throw new Error('no usable node');
        const recoveredContext = await readLatestContext();
        operation.controller.signal.throwIfAborted();
        if (!usable(recoveredContext) || recoveredContext.nodeName !== selectedNode) {
          adoptContext(recoveredContext);
          scheduleTimer(0);
          throw operation.controller.signal.reason ?? new Error('node health recovery became stale');
        }
        transitionRecoveredContext(recoveredContext, operation);
        nextDelayMs = 0;
        await options.onRecovered?.(selectedNode, operation.controller.signal);
        await verifyDelayOperation(operation);
      } catch (error) {
        if (operation.controller.signal.aborted || !ownsDelayOperation(operation)) throw error;
        await options.onBackgroundError?.(error);
        operation.controller.signal.throwIfAborted();
        if (!ownsDelayOperation(operation)) throw error;
      }
    })().finally(() => {
      if (activeDelay?.id === operation.id) {
        activeDelay = undefined;
        scheduleTimer(nextDelayMs);
      }
    });
    operation.promise = promise;
    activeDelay = operation;
    return promise;
  }

  async function recordManualDelay(
    nodeName: string,
    delay: number | undefined,
    testState?: ProxyNode['testState']
  ): Promise<void> {
    assertAvailable();
    const latest = await readLatestContext();
    assertAvailable();
    adoptContext(latest);
    if (!context || !usable(context) || context.nodeName !== nodeName.trim()) return;
    detachDelay(new Error('node health background check superseded by manual result'));
    if (testState !== 'testing' && typeof delay === 'number') {
      failureNodeName = context.nodeName;
      failureCount = 0;
    }
    health = {
      ...health,
      delayStatus: testState === 'testing' ? 'testing' : typeof delay === 'number' ? 'measured' : 'failed',
      delay: testState === 'testing' ? undefined : delay,
      delayCheckedAt: testState === 'testing' ? undefined : (options.now?.() ?? new Date()).toISOString()
    };
    emitHealthChanged();
    scheduleTimer(options.intervalMs);
  }

  async function getSnapshot(nextContext: Context): Promise<CurrentNodeHealth> {
    if (disposed) throw new Error('node health coordinator disposed');
    const contextChanged = adoptContext(nextContext);
    if (contextChanged) scheduleTimer(0);
    const snapshotGeneration = generation;
    const snapshotContextKey = keyOf(nextContext);
    if (!usable(nextContext)) return cloneHealth();
    if (!options.readCachedAvailability || !options.toAvailabilitySnapshot) return cloneHealth();

    let cached: AvailabilityRecord | undefined;
    try {
      cached = await options.readCachedAvailability(nextContext.nodeName);
    } catch (error) {
      await options.onAvailabilityError?.(error);
      return cloneHealth();
    }
    if (
      generation !== snapshotGeneration ||
      !context ||
      keyOf(context) !== snapshotContextKey ||
      context.nodeName !== nextContext.nodeName
    ) {
      return cloneHealth();
    }
    if (cached) {
      health = { ...health, availability: options.toAvailabilitySnapshot(cached) };
    } else if (
      health.availability.status === 'measured' &&
      !isLocalToday(health.availability.checkedAt, options.now?.() ?? new Date())
    ) {
      health = {
        ...health,
        availability: { status: 'untested', totalCount: options.totalAvailabilityCount }
      };
    }
    return cloneHealth();
  }

  return {
    start,
    stop,
    dispose,
    reschedule,
    invalidate: invalidateContext,
    checkNow,
    recordManualDelay,
    getSnapshot,
    inspect() {
      return {
        started,
        disposed,
        generation,
        health: cloneHealth(),
        timer,
        activeDelay: Boolean(activeDelay),
        activeAvailability: Boolean(activeAvailability),
        failures: { nodeName: failureNodeName, count: failureCount },
        context: context ? { ...context } : undefined
      };
    }
  };
}

function isLocalToday(isoDate: string | undefined, now: Date): boolean {
  if (!isoDate) return false;
  const checkedAt = new Date(isoDate);
  if (!Number.isFinite(checkedAt.getTime())) return false;
  return (
    checkedAt.getFullYear() === now.getFullYear() &&
    checkedAt.getMonth() === now.getMonth() &&
    checkedAt.getDate() === now.getDate()
  );
}
