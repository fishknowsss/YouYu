export type SystemProxyAdapter = {
  enable: () => Promise<void>;
  restore: () => Promise<void>;
  repair: () => Promise<void>;
};

export type MihomoRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export type LifecycleStatus = 'stopped' | 'running' | 'failed';

export type LifecycleController = {
  getStatus: () => LifecycleStatus;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  repair: () => Promise<void>;
};

export function createLifecycleController(deps: {
  proxy: SystemProxyAdapter;
  mihomo: MihomoRuntime;
}): LifecycleController {
  let status: LifecycleStatus = 'stopped';
  let operation: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = operation.then(task, task);
    operation = next.catch(() => undefined);
    return next;
  }

  async function rollbackFailedStart(error: unknown): Promise<never> {
    status = 'failed';
    await Promise.allSettled([deps.proxy.restore(), deps.mihomo.stop()]);
    throw error;
  }

  async function startInternal() {
    if (status === 'running') return;

    await deps.proxy.enable();
    try {
      await deps.mihomo.start();
      status = 'running';
    } catch (error) {
      await rollbackFailedStart(error);
    }
  }

  async function stopInternal() {
    if (status === 'stopped') return;

    const results = await Promise.allSettled([deps.proxy.restore(), deps.mihomo.stop()]);
    status = 'stopped';

    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      throw failure.reason;
    }
  }

  return {
    getStatus: () => status,
    async start() {
      await enqueue(startInternal);
    },
    async stop() {
      await enqueue(stopInternal);
    },
    async restart() {
      await enqueue(async () => {
        if (status !== 'running') {
          await startInternal();
          return;
        }

        await deps.mihomo.stop();
        try {
          await deps.mihomo.start();
          status = 'running';
        } catch (error) {
          await rollbackFailedStart(error);
        }
      });
    },
    async repair() {
      await enqueue(async () => {
        const results = await Promise.allSettled([deps.proxy.repair(), deps.mihomo.stop()]);
        status = 'stopped';

        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          throw failure.reason;
        }
      });
    }
  };
}
