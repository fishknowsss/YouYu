import { runRuntimeOperationWithSafeRetry } from './runtimeRecoveryPolicy';

type AppRuntimeActionsOptions = {
  start: (signal?: AbortSignal) => Promise<void>;
  restart: (signal?: AbortSignal) => Promise<void>;
  throwIfNetworkRepairInProgress: (allowDuringNetworkRepair?: boolean) => void;
  throwIfRuntimeIntentCanceled: (intentGeneration: number) => void;
  appendLog: (message: string) => void;
  formatError: (error: unknown) => string;
};

type StartOptions = {
  allowDuringNetworkRepair?: boolean;
};

export function createAppRuntimeActions(options: AppRuntimeActionsOptions) {
  async function start(
    signal?: AbortSignal,
    intentGeneration?: number,
    startOptions: StartOptions = {}
  ): Promise<void> {
    const assertAvailable = () => {
      options.throwIfNetworkRepairInProgress(startOptions.allowDuringNetworkRepair);
      if (intentGeneration !== undefined) options.throwIfRuntimeIntentCanceled(intentGeneration);
    };

    assertAvailable();
    await runRuntimeOperationWithSafeRetry(() => options.start(signal), {
      signal,
      beforeRetry(failure) {
        assertAvailable();
        options.appendLog(
          `启动遇到瞬时核心故障，正在安全重试一次 (${failure.code}): ${options.formatError(failure.error)}`
        );
      }
    });
    assertAvailable();
  }

  async function restart(intentGeneration: number, signal?: AbortSignal): Promise<void> {
    const assertAvailable = () => {
      options.throwIfNetworkRepairInProgress();
      options.throwIfRuntimeIntentCanceled(intentGeneration);
    };

    assertAvailable();
    await runRuntimeOperationWithSafeRetry(() => options.restart(signal), {
      signal,
      beforeRetry(failure) {
        assertAvailable();
        options.appendLog(
          `重启遇到瞬时核心故障，正在安全重试一次 (${failure.code}): ${options.formatError(failure.error)}`
        );
      }
    });
    assertAvailable();
  }

  function forIntent(intentGeneration: number) {
    return {
      start: (signal?: AbortSignal) => start(signal, intentGeneration),
      restart: (signal?: AbortSignal) => restart(intentGeneration, signal)
    };
  }

  return {
    start,
    restart,
    forIntent
  };
}
