export type SystemProxyAdapter = {
  enable: (signal?: AbortSignal) => Promise<void>;
  restore: () => Promise<void>;
  repair: (signal?: AbortSignal) => Promise<void>;
  disableForRepair?: (signal?: AbortSignal) => Promise<void>;
  repairSystemNetwork?: (signal?: AbortSignal) => Promise<void>;
};

export type MihomoRuntime = {
  start: (signal?: AbortSignal) => Promise<void>;
  stop: () => Promise<void>;
  isRunning?: () => boolean;
};

export type LifecycleStatus = 'stopped' | 'running' | 'failed';

export type LifecycleController = {
  getStatus: () => LifecycleStatus;
  markRuntimeExited?: (reason?: string) => void;
  suspendStarts: () => void;
  resumeStarts: () => void;
  start: (signal?: AbortSignal) => Promise<void>;
  stop: () => Promise<void>;
  restart: (signal?: AbortSignal) => Promise<void>;
  repair: (signal?: AbortSignal) => Promise<void>;
  shutdown: () => Promise<void>;
};

export function createLifecycleController(deps: {
  proxy: SystemProxyAdapter;
  mihomo: MihomoRuntime;
  onStatusChange?: (status: LifecycleStatus) => void;
}): LifecycleController {
  let status: LifecycleStatus = 'stopped';
  let operation: Promise<void> = Promise.resolve();
  let startsSuspended = false;
  let shuttingDown = false;
  let shutdownInProgress = false;

  function setStatus(next: LifecycleStatus) {
    if (status === next) return;
    status = next;
    deps.onStatusChange?.(status);
  }

  function reconcileStatus(): LifecycleStatus {
    if (status === 'running' && deps.mihomo.isRunning && !deps.mihomo.isRunning()) {
      setStatus('failed');
    }
    return status;
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = operation.then(task, task);
    operation = next.catch(() => undefined);
    return next;
  }

  function ensureOperationsAllowed() {
    if (shuttingDown || shutdownInProgress) throw new Error('lifecycle is shutting down');
    if (startsSuspended) throw new Error('lifecycle starts are suspended');
  }

  async function rollbackFailedStart(error: unknown): Promise<never> {
    setStatus('failed');
    try {
      await deps.proxy.restore();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'lifecycle start and proxy rollback failed', {
        cause: restoreError
      });
    }
    await deps.mihomo.stop().catch(() => undefined);
    throw error;
  }

  async function startInternal(signal?: AbortSignal) {
    ensureOperationsAllowed();
    if (reconcileStatus() === 'running') return;

    try {
      signal?.throwIfAborted();
      await deps.mihomo.start(signal);
      ensureOperationsAllowed();
      signal?.throwIfAborted();
      await deps.proxy.enable(signal);
      ensureOperationsAllowed();
      setStatus('running');
    } catch (error) {
      await rollbackFailedStart(error);
    }
  }

  async function stopInternal() {
    if (reconcileStatus() === 'stopped') return;

    try {
      await deps.proxy.restore();
      await deps.mihomo.stop();
    } catch (error) {
      setStatus('failed');
      throw error;
    }
    setStatus('stopped');
  }

  return {
    getStatus: reconcileStatus,
    markRuntimeExited() {
      if (status === 'running') {
        setStatus('failed');
      }
    },
    suspendStarts() {
      startsSuspended = true;
    },
    resumeStarts() {
      if (!shuttingDown && !shutdownInProgress) startsSuspended = false;
    },
    async start(signal) {
      await enqueue(() => startInternal(signal));
    },
    async stop() {
      await enqueue(stopInternal);
    },
    async restart(signal) {
      await enqueue(async () => {
        ensureOperationsAllowed();
        if (reconcileStatus() !== 'running') {
          await startInternal(signal);
          return;
        }

        try {
          await deps.proxy.restore();
          await deps.mihomo.stop();
        } catch (error) {
          setStatus('failed');
          throw error;
        }
        try {
          ensureOperationsAllowed();
          signal?.throwIfAborted();
          await deps.mihomo.start(signal);
          ensureOperationsAllowed();
          signal?.throwIfAborted();
          await deps.proxy.enable(signal);
          ensureOperationsAllowed();
          setStatus('running');
        } catch (error) {
          await rollbackFailedStart(error);
        }
      });
    },
    async repair(signal) {
      await enqueue(async () => {
        ensureOperationsAllowed();
        signal?.throwIfAborted();
        const disableForRepair = deps.proxy.disableForRepair;
        const repairSystemNetwork = deps.proxy.repairSystemNetwork;
        const useStagedRepair = Boolean(disableForRepair && repairSystemNetwork);
        try {
          if (useStagedRepair && disableForRepair) {
            await disableForRepair(signal);
          } else {
            await deps.proxy.repair(signal);
          }
          await deps.mihomo.stop();
        } catch (error) {
          setStatus('failed');
          throw error;
        }
        setStatus('stopped');
        if (useStagedRepair && repairSystemNetwork) {
          await repairSystemNetwork(signal);
        }
      });
    },
    async shutdown() {
      shutdownInProgress = true;
      startsSuspended = true;
      try {
        await enqueue(stopInternal);
        shuttingDown = true;
      } catch (error) {
        startsSuspended = false;
        throw error;
      } finally {
        shutdownInProgress = false;
      }
    }
  };
}
