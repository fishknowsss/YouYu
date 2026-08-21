import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiagnosticIssueKind } from '../shared/ipc';

type RepairStatus = 'stopped' | 'running' | 'failed';

export type NetworkRepairDependencies<TSnapshot> = {
  getStatus: () => RepairStatus;
  captureRuntimeIntent: () => number | undefined;
  isRuntimeIntentCurrent: (generation: number) => boolean;
  pauseBackgroundWork: () => void;
  prepareRunningRuntime: () => Promise<void>;
  runTargetedRepair?: (issueKind: DiagnosticIssueKind, signal?: AbortSignal) => Promise<void>;
  compensateCanceledTargetedRepair?: () => Promise<void>;
  onTargetedRepairError?: (issueKind: DiagnosticIssueKind, error: unknown) => void;
  onSupplementalRepairError?: (error: unknown) => void;
  repairLifecycle: (signal?: AbortSignal) => Promise<void>;
  clearRuntimeCache: () => Promise<void>;
  startRuntime: (signal: AbortSignal | undefined, intentGeneration: number) => Promise<void>;
  resumeRunningWork: () => void;
  createSnapshot: () => Promise<TSnapshot>;
};

export type NetworkRepairOptions = {
  resumeRuntime?: boolean;
  issueKind?: DiagnosticIssueKind;
};

export async function runNetworkRepair<TSnapshot>(
  deps: NetworkRepairDependencies<TSnapshot>,
  options: NetworkRepairOptions = {},
  signal?: AbortSignal
): Promise<TSnapshot> {
  signal?.throwIfAborted();
  const initialStatus = deps.getStatus();
  const intentGeneration = deps.captureRuntimeIntent();

  if (initialStatus === 'running') {
    await deps.prepareRunningRuntime();
  }
  signal?.throwIfAborted();
  deps.pauseBackgroundWork();

  async function throwIfRepairCanceled(targeted = false): Promise<void> {
    if (!signal?.aborted) return;
    try {
      const status = deps.getStatus();
      if (status === 'running') {
        await deps.compensateCanceledTargetedRepair?.();
        if (deps.getStatus() === 'running') {
          if (initialStatus === 'running') deps.resumeRunningWork();
        } else {
          await deps.repairLifecycle();
          if (deps.getStatus() !== 'stopped') {
            throw new Error('canceled repair did not finish runtime cleanup');
          }
        }
      } else if (targeted || status !== 'stopped') {
        await deps.repairLifecycle();
        if (deps.getStatus() !== 'stopped') {
          throw new Error('canceled repair did not finish runtime cleanup');
        }
      }
    } catch (error) {
      throw new AggregateError(
        [signal.reason ?? new Error('operation canceled'), error],
        'network repair cancellation compensation failed',
        { cause: error }
      );
    }
    signal.throwIfAborted();
  }

  if (options.issueKind && deps.runTargetedRepair) {
    try {
      await deps.runTargetedRepair(options.issueKind, signal);
    } catch (error) {
      await throwIfRepairCanceled(true);
      deps.onTargetedRepairError?.(options.issueKind, error);
    }
    await throwIfRepairCanceled(true);
  }

  let repairError: unknown;
  try {
    await deps.repairLifecycle(signal);
  } catch (error) {
    repairError = error;
  }
  if (signal?.aborted && deps.getStatus() !== 'stopped') {
    await throwIfRepairCanceled();
  }

  let cacheError: unknown;
  if (deps.getStatus() === 'stopped') {
    try {
      await deps.clearRuntimeCache();
    } catch (error) {
      cacheError = error;
    }
  }

  const stoppedAfterRepair = deps.getStatus() === 'stopped';
  if (repairError !== undefined && !stoppedAfterRepair) {
    if (initialStatus === 'running' && deps.getStatus() === 'running') deps.resumeRunningWork();
    throw repairError;
  }
  const supplementalFailures = [repairError, cacheError].filter((error) => error !== undefined);
  signal?.throwIfAborted();

  if (options.resumeRuntime !== false && intentGeneration !== undefined) {
    if (!deps.isRuntimeIntentCurrent(intentGeneration)) throw new Error('proxy start canceled');
    try {
      await deps.startRuntime(signal, intentGeneration);
    } catch (error) {
      signal?.throwIfAborted();
      if (supplementalFailures.length === 0) throw error;
      throw new AggregateError([...supplementalFailures, error], 'network repair and runtime recovery failed', {
        cause: error
      });
    }
    signal?.throwIfAborted();
    if (!deps.isRuntimeIntentCurrent(intentGeneration)) throw new Error('proxy start canceled');
    if (deps.getStatus() !== 'running') {
      const error = new Error('network repair did not restore the runtime');
      if (supplementalFailures.length === 0) throw error;
      throw new AggregateError([...supplementalFailures, error], 'network repair and runtime recovery failed', {
        cause: error
      });
    }
    deps.resumeRunningWork();
  }

  if (supplementalFailures.length === 1) {
    deps.onSupplementalRepairError?.(supplementalFailures[0]);
  } else if (supplementalFailures.length > 1) {
    deps.onSupplementalRepairError?.(
      new AggregateError(supplementalFailures, 'network repair completed with supplemental failures', {
        cause: supplementalFailures[0]
      })
    );
  }

  return deps.createSnapshot();
}

export async function clearMihomoRepairCache(userDataDir: string): Promise<void> {
  await rm(join(userDataDir, 'mihomo', 'cache.db'), { force: true });
}
