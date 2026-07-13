import type { TrafficRegistrationInput } from '../../shared/ipc';

type TrafficRegistrationReporter = {
  register: (input: TrafficRegistrationInput, options?: { proxyUrl?: string }) => Promise<unknown>;
};

type TrafficRegistrationStore = {
  registerPendingIdentity: (input: TrafficRegistrationInput) => Promise<unknown>;
  getPendingRegistration: () => Promise<TrafficRegistrationInput | undefined>;
  clearIdentity: (message?: string) => Promise<void>;
};

export type TrafficRegistrationCoordinator = {
  register: (input: TrafficRegistrationInput) => Promise<void>;
  activatePending: () => Promise<boolean>;
};

export type TemporaryRuntimeRelease = () => Promise<void>;

export type TemporaryRuntimeLeaseManager = {
  acquire: () => Promise<TemporaryRuntimeRelease>;
};

type TemporaryRuntimeSession = {
  phase: 'starting' | 'active' | 'stopping';
  leaseCount: number;
  startPromise: Promise<void>;
  stopPromise?: Promise<void>;
};

export function createTemporaryRuntimeLeaseManager(deps: {
  isRuntimeRunning: () => boolean;
  captureRuntimeIntent: () => number | undefined;
  startRuntime: (intentGeneration?: number) => Promise<void>;
  stopRuntime: () => Promise<void>;
  log?: (message: string) => void;
}): TemporaryRuntimeLeaseManager {
  const log = deps.log ?? (() => undefined);
  const noOpRelease: TemporaryRuntimeRelease = async () => undefined;
  let session: TemporaryRuntimeSession | undefined;

  function createRelease(current: TemporaryRuntimeSession): TemporaryRuntimeRelease {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      current.leaseCount = Math.max(0, current.leaseCount - 1);
      if (session !== current || current.leaseCount > 0) return;

      const intentBeforeStop = deps.captureRuntimeIntent();
      if (intentBeforeStop !== undefined) {
        session = undefined;
        log('用户已请求启动代理，登记流程保留当前代理');
        return;
      }

      current.phase = 'stopping';
      current.stopPromise = (async () => {
        let cleanupError: unknown;
        try {
          await deps.stopRuntime();
        } catch (error) {
          cleanupError = error;
        }

        const intentAfterStop = deps.captureRuntimeIntent();
        if (intentAfterStop !== undefined) {
          log('用户在临时代理释放期间请求启动，正在恢复代理');
          try {
            await deps.startRuntime(intentAfterStop);
          } catch (error) {
            log(`用户请求的代理恢复失败：${defaultFormatError(error)}`);
            cleanupError ??= error;
          }
        }

        if (session === current) session = undefined;
        if (cleanupError) throw cleanupError;
      })();
      await current.stopPromise;
    };
  }

  async function acquire(): Promise<TemporaryRuntimeRelease> {
    const intentGeneration = deps.captureRuntimeIntent();
    if (intentGeneration !== undefined) {
      await deps.startRuntime(intentGeneration);
      return noOpRelease;
    }

    const current = session;
    if (current?.phase === 'stopping') {
      await current.stopPromise?.catch(() => undefined);
      return acquire();
    }
    if (current) {
      current.leaseCount += 1;
      try {
        await current.startPromise;
      } catch (error) {
        current.leaseCount = Math.max(0, current.leaseCount - 1);
        if (session === current && current.leaseCount === 0) session = undefined;
        throw error;
      }
      return createRelease(current);
    }

    if (deps.isRuntimeRunning()) return noOpRelease;

    const created: TemporaryRuntimeSession = {
      phase: 'starting',
      leaseCount: 1,
      startPromise: Promise.resolve()
    };
    session = created;
    created.startPromise = Promise.resolve()
      .then(() => deps.startRuntime())
      .then(() => {
        if (session === created) created.phase = 'active';
      });
    try {
      await created.startPromise;
    } catch (error) {
      created.leaseCount = 0;
      if (session === created) session = undefined;
      throw error;
    }
    return createRelease(created);
  }

  return { acquire };
}

export function createTrafficRegistrationCoordinator(deps: {
  reporter: TrafficRegistrationReporter;
  store: TrafficRegistrationStore;
  hasSubscription: () => Promise<boolean>;
  acquireTemporaryRuntime: () => Promise<TemporaryRuntimeRelease>;
  stopRuntime: () => Promise<void>;
  getProxyUrl: () => string | undefined;
  formatError?: (error: unknown) => string;
  log?: (message: string) => void;
}): TrafficRegistrationCoordinator {
  const formatError = deps.formatError ?? defaultFormatError;
  const log = deps.log ?? (() => undefined);

  async function storePending(input: TrafficRegistrationInput, error: unknown) {
    log(`登记暂存，等待代理可用后重试：${formatError(error)}`);
    await deps.store.registerPendingIdentity(input);
  }

  return {
    async register(input) {
      try {
        await deps.reporter.register(input, {
          proxyUrl: deps.getProxyUrl()
        });
        return;
      } catch (directError) {
        if (!shouldRetryRegistrationViaProxy(directError, formatError)) {
          throw directError;
        }

        if (!(await deps.hasSubscription())) {
          await storePending(input, directError);
          return;
        }

        log(`登记请求失败，准备通过代理重试：${formatError(directError)}`);
        let releaseTemporaryRuntime: TemporaryRuntimeRelease;
        try {
          releaseTemporaryRuntime = await deps.acquireTemporaryRuntime();
        } catch (startError) {
          await storePending(input, startError);
          return;
        }

        let registrationError: unknown;
        try {
          await deps.reporter.register(input, { proxyUrl: deps.getProxyUrl() });
        } catch (proxyError) {
          log(`登记代理重试失败：${formatError(proxyError)}`);
          if (isPermanentTrafficActivationFailure(proxyError, formatError)) {
            registrationError = proxyError;
          } else {
            try {
              await deps.store.registerPendingIdentity(input);
            } catch (storeError) {
              registrationError = storeError;
            }
          }
        }

        try {
          await releaseTemporaryRuntime();
        } catch (releaseError) {
          log(`临时代理释放失败：${formatError(releaseError)}`);
          registrationError ??= releaseError;
        }
        if (registrationError) throw registrationError;
      }
    },

    async activatePending() {
      const pending = await deps.store.getPendingRegistration();
      if (!pending) return false;

      try {
        await deps.reporter.register(pending, { proxyUrl: deps.getProxyUrl() });
        log('待验证登记已完成');
        return true;
      } catch (error) {
        if (!isPermanentTrafficActivationFailure(error, formatError)) {
          log(`待验证登记暂未完成：${formatError(error)}`);
          return false;
        }

        try {
          await deps.store.clearIdentity(formatError(error));
        } catch (clearError) {
          log(`登记失效后清除流量身份失败：${formatError(clearError)}`);
        }
        try {
          await deps.stopRuntime();
        } catch (stopError) {
          log(`登记失效后停止代理失败：${formatError(stopError)}`);
        }
        throw error;
      }
    }
  };
}

export function shouldRetryRegistrationViaProxy(
  error: unknown,
  formatError: (error: unknown) => string = defaultFormatError
): boolean {
  const message = formatError(error);
  if (message.includes('traffic endpoint not configured')) return false;
  if (isPermanentTrafficActivationFailure(error, formatError)) return false;
  if (/traffic activation failed: (408|429|5\d\d)/.test(message)) return true;
  return [
    'fetch failed',
    'Failed to fetch',
    'traffic request timed out',
    'traffic proxy connect timed out',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN'
  ].some((needle) => message.includes(needle));
}

export function isPermanentTrafficActivationFailure(
  error: unknown,
  formatError: (error: unknown) => string = defaultFormatError
): boolean {
  return /traffic activation failed: (400|403|409)(?:\s|$)/.test(formatError(error));
}

function defaultFormatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
