export type SystemProxyAdapter = {
  enable: (signal?: AbortSignal) => Promise<void>;
  restore: () => Promise<void>;
  repair: (signal?: AbortSignal) => Promise<void>;
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
  start: (signal?: AbortSignal) => Promise<void>;
  stop: () => Promise<void>;
  restart: (signal?: AbortSignal) => Promise<void>;
  repair: (signal?: AbortSignal) => Promise<void>;
};

export function createLifecycleController(deps: {
  proxy: SystemProxyAdapter;
  mihomo: MihomoRuntime;
  onStatusChange?: (status: LifecycleStatus) => void;
}): LifecycleController {
  let status: LifecycleStatus = 'stopped';
  let operation: Promise<void> = Promise.resolve();

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

  async function rollbackFailedStart(error: unknown): Promise<never> {
    setStatus('failed');
    await Promise.allSettled([deps.proxy.restore(), deps.mihomo.stop()]);
    throw error;
  }

  async function startInternal(signal?: AbortSignal) {
    if (reconcileStatus() === 'running') return;

    try {
      signal?.throwIfAborted();
      await deps.mihomo.start(signal);
      signal?.throwIfAborted();
      await deps.proxy.enable(signal);
      setStatus('running');
    } catch (error) {
      await rollbackFailedStart(error);
    }
  }

  async function stopInternal() {
    if (reconcileStatus() === 'stopped') return;

    const results = await Promise.allSettled([deps.proxy.restore(), deps.mihomo.stop()]);
    setStatus('stopped');

    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      throw failure.reason;
    }
  }

  return {
    getStatus: reconcileStatus,
    markRuntimeExited() {
      if (status === 'running') {
        setStatus('failed');
      }
    },
    async start(signal) {
      await enqueue(() => startInternal(signal));
    },
    async stop() {
      await enqueue(stopInternal);
    },
    async restart(signal) {
      await enqueue(async () => {
        if (reconcileStatus() !== 'running') {
          await startInternal(signal);
          return;
        }

        await Promise.allSettled([deps.proxy.restore(), deps.mihomo.stop()]);
        try {
          signal?.throwIfAborted();
          await deps.mihomo.start(signal);
          signal?.throwIfAborted();
          await deps.proxy.enable(signal);
          setStatus('running');
        } catch (error) {
          await rollbackFailedStart(error);
        }
      });
    },
    async repair(signal) {
      await enqueue(async () => {
        signal?.throwIfAborted();
        const results = await Promise.allSettled([deps.mihomo.stop(), deps.proxy.repair(signal)]);
        setStatus('stopped');

        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          throw failure.reason;
        }
      });
    }
  };
}
