import { LatestOperationCoordinator } from './latestOperationCoordinator';

/**
 * Serializes every Mihomo selector mutation. Automatic work is replaceable,
 * while an explicit user action first waits for the superseded operation to
 * finish its rollback before it is allowed to write a newer choice.
 */
export class NodeSelectionCoordinator {
  private readonly operations = new LatestOperationCoordinator<unknown>();

  replaceAutomatic<Result>(
    externalSignal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<Result>
  ): Promise<Result> {
    return this.operations.replace(({ signal }) => {
      const operationSignal = externalSignal ? AbortSignal.any([externalSignal, signal]) : signal;
      operationSignal.throwIfAborted();
      return action(operationSignal);
    }) as Promise<Result>;
  }

  coalesceAutomatic<Result>(
    externalSignal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<Result>
  ): Promise<Result> {
    externalSignal?.throwIfAborted();
    const shared = this.operations.coalesce(({ signal }) => {
      const operationSignal = externalSignal ? AbortSignal.any([externalSignal, signal]) : signal;
      operationSignal.throwIfAborted();
      return action(operationSignal);
    }) as Promise<Result>;
    return observeWithSignal(shared, externalSignal);
  }

  runUserAction<Result>(action: () => Promise<Result>): Promise<Result> {
    return this.operations.cancelThen(action);
  }

  cancel(): Promise<void> {
    return this.operations.cancel();
  }
}

function observeWithSignal<Result>(promise: Promise<Result>, signal: AbortSignal | undefined): Promise<Result> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(toAbortReason(signal.reason));

  return new Promise<Result>((resolve, reject) => {
    const onAbort = () => reject(toAbortReason(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function toAbortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('operation canceled');
}
