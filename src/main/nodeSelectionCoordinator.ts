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

  runUserAction<Result>(action: () => Promise<Result>): Promise<Result> {
    return this.operations.cancelThen(action);
  }

  cancel(): Promise<void> {
    return this.operations.cancel();
  }
}
