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
  onTargetedRepairError?: (issueKind: DiagnosticIssueKind, error: unknown) => void;
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

  if (options.issueKind && deps.runTargetedRepair) {
    try {
      await deps.runTargetedRepair(options.issueKind, signal);
    } catch (error) {
      signal?.throwIfAborted();
      deps.onTargetedRepairError?.(options.issueKind, error);
    }
    signal?.throwIfAborted();
  }

  let repairError: unknown;
  try {
    await deps.repairLifecycle(signal);
  } catch (error) {
    repairError = error;
  }

  let cacheError: unknown;
  if (deps.getStatus() === 'stopped') {
    try {
      await deps.clearRuntimeCache();
    } catch (error) {
      cacheError = error;
    }
  }

  if (repairError !== undefined && cacheError !== undefined) {
    throw new AggregateError([repairError, cacheError], 'network repair and runtime cache cleanup failed', {
      cause: repairError
    });
  }
  if (repairError !== undefined) throw repairError;
  if (cacheError !== undefined) throw cacheError;
  signal?.throwIfAborted();

  if (options.resumeRuntime !== false && intentGeneration !== undefined) {
    if (!deps.isRuntimeIntentCurrent(intentGeneration)) throw new Error('proxy start canceled');
    await deps.startRuntime(signal, intentGeneration);
    signal?.throwIfAborted();
    if (!deps.isRuntimeIntentCurrent(intentGeneration)) throw new Error('proxy start canceled');
    if (deps.getStatus() !== 'running') throw new Error('network repair did not restore the runtime');
    deps.resumeRunningWork();
  }

  return deps.createSnapshot();
}

export async function clearMihomoRepairCache(userDataDir: string): Promise<void> {
  await rm(join(userDataDir, 'mihomo', 'cache.db'), { force: true });
}
