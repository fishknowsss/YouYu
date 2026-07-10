import type { OperationRequest } from '../shared/ipc';

type OperationRecord = {
  controller: AbortController;
  senderId: number;
  settled: Promise<void>;
};

export class IpcOperationRegistry {
  private readonly operations = new Map<string, OperationRecord>();

  constructor(private readonly onCleanupError?: (error: unknown) => void) {}

  async cancel(senderId: number, value: unknown): Promise<boolean> {
    const requestId = normalizeOperationRequestId(value);
    const operation = this.operations.get(requestId);
    if (!operation || operation.senderId !== senderId) return false;
    operation.controller.abort(new Error('operation canceled'));
    await operation.settled;
    return true;
  }

  async cancelSender(senderId: number): Promise<void> {
    const matches = [...this.operations.values()].filter((operation) => operation.senderId === senderId);
    matches.forEach((operation) => operation.controller.abort(new Error('operation canceled')));
    await Promise.all(matches.map((operation) => operation.settled));
  }

  async run<T>(
    senderId: number,
    request: OperationRequest | undefined,
    action: (signal: AbortSignal) => Promise<T>,
    onAbort?: () => Promise<unknown>
  ): Promise<T> {
    const requestId = normalizeOperationRequestId(request?.requestId);
    const controller = new AbortController();
    if (requestId && this.operations.has(requestId)) throw new Error('operation request id already active');
    let abortHandler: (() => void) | undefined;
    let settleCleanup: () => void = () => undefined;
    let cleanupStarted = false;
    const cleanupSettled = new Promise<void>((resolve) => {
      settleCleanup = resolve;
    });
    const startAbortCleanup = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      void Promise.resolve()
        .then(() => onAbort?.())
        .catch((error) => this.onCleanupError?.(error))
        .finally(settleCleanup);
    };
    const aborted = new Promise<never>((_resolve, reject) => {
      abortHandler = () => {
        startAbortCleanup();
        reject(controller.signal.reason ?? new Error('operation canceled'));
      };
      controller.signal.addEventListener('abort', abortHandler, { once: true });
    });
    const actionPromise = Promise.resolve().then(() => action(controller.signal));
    const settled = Promise.allSettled([actionPromise, cleanupSettled]).then(() => undefined);
    if (requestId) {
      this.operations.set(requestId, { controller, senderId, settled });
    }

    try {
      const result = await Promise.race([actionPromise, aborted]);
      return result;
    } finally {
      if (abortHandler) controller.signal.removeEventListener('abort', abortHandler);
      if (!controller.signal.aborted) settleCleanup();
      await settled;
      if (requestId && this.operations.get(requestId)?.controller === controller) this.operations.delete(requestId);
    }
  }
}

export function normalizeOperationRequestId(value: unknown): string {
  const requestId = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9-]{8,80}$/.test(requestId) ? requestId : '';
}
