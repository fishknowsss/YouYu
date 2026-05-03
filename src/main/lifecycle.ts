export type SystemProxyAdapter = {
  enable: () => Promise<void>;
  restore: () => Promise<void>;
  repair: () => Promise<void>;
};

export type MihomoRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning?: () => boolean;
};

export type LifecycleStatus = 'stopped' | 'running' | 'failed';

export type LifecycleController = {
  getStatus: () => LifecycleStatus;
  markRuntimeExited?: (reason?: string) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  repair: () => Promise<void>;
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

  async function startInternal() {
    if (reconcileStatus() === 'running') return;

    try {
      await deps.mihomo.start();
      await deps.proxy.enable();
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
    async start() {
      await enqueue(startInternal);
    },
    async stop() {
      await enqueue(stopInternal);
    },
    async restart() {
      await enqueue(async () => {
        if (reconcileStatus() !== 'running') {
          await startInternal();
          return;
        }

        await Promise.allSettled([deps.proxy.restore(), deps.mihomo.stop()]);
        try {
          await deps.mihomo.start();
          await deps.proxy.enable();
          setStatus('running');
        } catch (error) {
          await rollbackFailedStart(error);
        }
      });
    },
    async repair() {
      await enqueue(async () => {
        const results = await Promise.allSettled([deps.proxy.repair(), deps.mihomo.stop()]);
        setStatus('stopped');

        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          throw failure.reason;
        }
      });
    }
  };
}
