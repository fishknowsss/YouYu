import { describe, expect, it, vi } from 'vitest';
import { IpcOperationRegistry, normalizeOperationRequestId } from '../../src/main/ipcOperations';

describe('IpcOperationRegistry', () => {
  it('allows only the originating renderer to cancel an active operation', async () => {
    const registry = new IpcOperationRegistry();
    let signal: AbortSignal | undefined;
    const running = registry.run(7, { requestId: 'request-123' }, (nextSignal) => {
      signal = nextSignal;
      return new Promise<void>((_resolve, reject) => {
        nextSignal.addEventListener('abort', () => reject(nextSignal.reason), { once: true });
      });
    });

    await expect(registry.cancel(8, 'request-123')).resolves.toBe(false);
    expect(signal?.aborted).toBe(false);
    const canceled = registry.cancel(7, 'request-123');
    await expect(running).rejects.toThrow('operation canceled');
    await expect(canceled).resolves.toBe(true);
    expect(signal?.aborted).toBe(true);
    await expect(registry.cancel(7, 'request-123')).resolves.toBe(false);
  });

  it('runs cancellation cleanup and rejects duplicate active ids', async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanup = vi.fn(async () => cleanupGate);
    const registry = new IpcOperationRegistry();
    const running = registry.run(
      1,
      { requestId: 'request-456' },
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      cleanup
    );

    await expect(registry.run(1, { requestId: 'request-456' }, async () => undefined)).rejects.toThrow(
      'already active'
    );
    const canceled = registry.cancel(1, 'request-456');
    const runningAssertion = expect(running).rejects.toThrow('operation canceled');
    let cancelSettled = false;
    void canceled.finally(() => {
      cancelSettled = true;
    });
    await Promise.resolve();
    expect(cancelSettled).toBe(false);
    releaseCleanup?.();
    await runningAssertion;
    await expect(canceled).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects malformed request ids from the cancellation registry', () => {
    expect(normalizeOperationRequestId('../escape')).toBe('');
    expect(normalizeOperationRequestId('short')).toBe('');
    expect(normalizeOperationRequestId('safe-request-123')).toBe('safe-request-123');
  });
});
