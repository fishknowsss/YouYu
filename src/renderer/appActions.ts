import type { AppSnapshot, OperationRequest } from '../shared/ipc';
import { isExpectedOperationCancellation } from '../shared/operationCancellation';
import { getActionErrorMessage as formatSharedActionErrorMessage } from '../shared/userFacingCopy';
import { createOperationRequest } from './operationRequest';

export type OperationRequestTracker = {
  current?: OperationRequest;
  next: () => OperationRequest;
};

export async function startEasyProxy(
  api: NonNullable<Window['youyu']>,
  requestTracker: OperationRequestTracker,
  signal?: AbortSignal
): Promise<AppSnapshot> {
  try {
    return await startAndSelectUsableNode(api, requestTracker, signal);
  } catch (error) {
    if (isInputError(error) || isOperationCancelled(error)) {
      throw error;
    }

    signal?.throwIfAborted();
    await api.repair(requestTracker.next()).catch((repairError) => {
      if (isOperationCancelled(repairError)) throw repairError;
      return undefined;
    });
    signal?.throwIfAborted();
    try {
      return await startAndSelectUsableNode(api, requestTracker, signal);
    } catch (retryError) {
      if (isOperationCancelled(retryError)) throw retryError;
      signal?.throwIfAborted();
      await api.repair(requestTracker.next()).catch((repairError) => {
        if (isOperationCancelled(repairError)) throw repairError;
        return undefined;
      });
      throw retryError;
    }
  }
}

async function startAndSelectUsableNode(
  api: NonNullable<Window['youyu']>,
  requestTracker: OperationRequestTracker,
  signal?: AbortSignal
): Promise<AppSnapshot> {
  signal?.throwIfAborted();
  const current = await api.getSnapshot();
  signal?.throwIfAborted();
  return current.status === 'running' ? current : await api.start(requestTracker.next());
}

function isInputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('missing subscription url') || message.includes('核心接口未加载');
}

function isOperationCancelled(error: unknown): boolean {
  return isExpectedOperationCancellation(error);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation = '操作',
  onTimeout?: () => void,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const racers: Promise<T>[] = [
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch {
            // The timeout result must not depend on best-effort cancellation.
          }
          reject(new ActionTimeoutError(operation));
        }, timeoutMs);
      })
    ];
    if (signal) {
      racers.push(
        new Promise<T>((_resolve, reject) => {
          abortHandler = () => reject(toAbortError(signal.reason));
          if (signal.aborted) {
            abortHandler();
            return;
          }
          signal.addEventListener('abort', abortHandler, { once: true });
        })
      );
    }
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

function toAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('operation canceled');
}

export function getActionErrorMessage(error: unknown): string {
  return formatSharedActionErrorMessage(error);
}

export class ActionTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`operation timed out: ${operation}`);
    this.name = 'ActionTimeoutError';
  }
}

export function createOperationRequestTracker(
  onNext?: (request: OperationRequest, previous?: OperationRequest) => void
): OperationRequestTracker {
  const tracker: OperationRequestTracker = {
    next: () => {
      const previous = tracker.current;
      const request = createOperationRequest();
      tracker.current = request;
      onNext?.(request, previous);
      return request;
    }
  };
  return tracker;
}
