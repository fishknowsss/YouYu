import type { LifecycleStatus } from './lifecycle';

export type AppRuntimeOperationKind = 'start' | 'stop' | 'restart' | 'recover';

export type AppRuntimeOperationContext = {
  kind: AppRuntimeOperationKind;
  generation: number;
  signal: AbortSignal;
};

export type AppRuntimeCoordinatorSnapshot = {
  status: LifecycleStatus;
  generation: number;
  operation?: AppRuntimeOperationKind;
};

type AppRuntimeCoordinatorOptions<StartResult, StopResult, RestartResult, RecoverResult> = {
  getStatus: () => LifecycleStatus;
  start: (context: AppRuntimeOperationContext) => Promise<StartResult>;
  stop: (context: AppRuntimeOperationContext) => Promise<StopResult>;
  restart: (context: AppRuntimeOperationContext) => Promise<RestartResult>;
  recover: (context: AppRuntimeOperationContext) => Promise<RecoverResult>;
  canRecover?: () => boolean;
  onOperationChange?: (snapshot: AppRuntimeCoordinatorSnapshot) => void;
  onBackgroundError?: (error: unknown) => void;
};

type ActiveOperation = {
  id: symbol;
  kind: AppRuntimeOperationKind;
  generation: number;
  controller: AbortController;
  promise: Promise<unknown>;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export function createAppRuntimeCoordinator<StartResult, StopResult, RestartResult, RecoverResult>(
  options: AppRuntimeCoordinatorOptions<StartResult, StopResult, RestartResult, RecoverResult>
) {
  let generation = 0;
  let active: ActiveOperation | undefined;
  let recoveryTimer: TimerHandle | undefined;
  let recoveryPending = false;
  let disposed = false;

  function inspect(): AppRuntimeCoordinatorSnapshot {
    return {
      status: options.getStatus(),
      generation,
      operation: active?.kind
    };
  }

  function notify(): void {
    try {
      options.onOperationChange?.(inspect());
    } catch (error) {
      try {
        options.onBackgroundError?.(error);
      } catch {
        // Observability hooks must never change runtime ownership.
      }
    }
  }

  function assertAvailable(): void {
    if (disposed) throw new Error('app runtime coordinator disposed');
  }

  function clearRecoveryTimer(): void {
    recoveryPending = false;
    if (!recoveryTimer) return;
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
  }

  function drainPendingRecovery(): void {
    if (!recoveryPending || disposed || active) return;
    recoveryPending = false;
    if (options.canRecover && !options.canRecover()) return;
    scheduleRecovery(0);
  }

  function abortActive(reason: Error, kind?: AppRuntimeOperationKind): void {
    if (!active || (kind && active.kind !== kind) || active.controller.signal.aborted) return;
    active.controller.abort(reason);
  }

  function begin<Result>(
    kind: AppRuntimeOperationKind,
    action: (context: AppRuntimeOperationContext) => Promise<Result>,
    externalSignal?: AbortSignal
  ): Promise<Result> {
    assertAvailable();
    externalSignal?.throwIfAborted();
    if (active?.kind === kind && !active.controller.signal.aborted) {
      return observeWithSignal(active.promise as Promise<Result>, externalSignal);
    }

    if (kind === 'recover' && active) return Promise.resolve(undefined as Result);
    if (active) {
      abortActive(new Error(`app runtime ${active.kind} superseded by ${kind}`));
    }
    if (kind !== 'recover') clearRecoveryTimer();

    generation += 1;
    const operationGeneration = generation;
    const controller = new AbortController();
    const unlinkSignal = linkAbortSignal(externalSignal, controller);
    const operation: ActiveOperation = {
      id: Symbol(kind),
      kind,
      generation: operationGeneration,
      controller,
      promise: Promise.resolve(undefined)
    };
    const promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return action({ kind, generation: operationGeneration, signal: controller.signal });
      })
      .then((result) => {
        controller.signal.throwIfAborted();
        return result;
      })
      .catch((error: unknown) => {
        controller.signal.throwIfAborted();
        throw error;
      })
      .finally(() => {
        unlinkSignal();
        if (active?.id === operation.id) {
          active = undefined;
          notify();
          drainPendingRecovery();
        }
      });
    operation.promise = promise;
    active = operation;
    notify();
    return promise;
  }

  function start(signal?: AbortSignal): Promise<StartResult> {
    return begin('start', options.start, signal);
  }

  function stop(signal?: AbortSignal): Promise<StopResult> {
    return begin('stop', options.stop, signal);
  }

  function restart(signal?: AbortSignal): Promise<RestartResult> {
    return begin('restart', options.restart, signal);
  }

  function recover(signal?: AbortSignal): Promise<RecoverResult | undefined> {
    assertAvailable();
    signal?.throwIfAborted();
    if (options.canRecover && !options.canRecover()) return Promise.resolve(undefined);
    return begin('recover', options.recover, signal);
  }

  function scheduleRecovery(delayMs: number): void {
    assertAvailable();
    clearRecoveryTimer();
    if (options.canRecover && !options.canRecover()) return;
    const delay = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0;
    const scheduledGeneration = generation;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      if (disposed || scheduledGeneration !== generation || (options.canRecover && !options.canRecover())) return;
      if (active) {
        recoveryPending = true;
        return;
      }
      void recover().catch((error) => options.onBackgroundError?.(error));
    }, delay);
    recoveryTimer.unref?.();
  }

  function stopRecovery(): void {
    clearRecoveryTimer();
    if (active?.kind !== 'recover') return;
    const operation = active;
    active = undefined;
    generation += 1;
    operation.controller.abort(new Error('app runtime recovery stopped'));
    notify();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation += 1;
    clearRecoveryTimer();
    const operation = active;
    active = undefined;
    operation?.controller.abort(new Error('app runtime coordinator disposed'));
    notify();
  }

  return {
    start,
    stop,
    restart,
    recover,
    scheduleRecovery,
    clearRecoveryTimer,
    stopRecovery,
    dispose,
    inspect,
    hasRecoveryTimer: () => Boolean(recoveryTimer)
  };
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
