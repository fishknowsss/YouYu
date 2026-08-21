import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
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

  it('does not stop a running runtime when non-start IPC operations are canceled', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const operationChannels = ['selectBestAutoNode', 'updateSubscription', 'saveSettings', 'syncRemoteConfig'];

    for (const channel of operationChannels) {
      const start = source.indexOf(`ipcMain.handle(ipcChannels.${channel}`);
      const end = source.indexOf('ipcMain.handle(ipcChannels.', start + 1);
      const handler = source.slice(start, end);
      expect(start, `${channel} handler should exist`).toBeGreaterThan(-1);
      expect(handler, `${channel} cancellation must not stop the runtime`).not.toContain('cancelProxyStart');
    }

    const repairStart = source.indexOf('ipcMain.handle(ipcChannels.repair');
    const repairEnd = source.indexOf('ipcMain.handle(ipcChannels.', repairStart + 1);
    const repairHandler = source.slice(repairStart, repairEnd);
    expect(repairHandler).not.toContain('cancelProxyStart');

    const runtimeActions = source.slice(
      source.indexOf('const userRuntimeActions'),
      source.indexOf('type SubscriptionRefreshOutcome')
    );
    const remoteSync = source.slice(
      source.indexOf('async function performRemoteConfigSync'),
      source.indexOf('async function syncRemoteConfig')
    );
    expect(runtimeActions).toContain('restart: () => restartLifecycleForUser()');
    expect(remoteSync).toContain('await restartLifecycleForIntent(options.intentGeneration);');
    expect(remoteSync).not.toContain('restartLifecycleForIntent(options.intentGeneration, options.signal)');

    const stopRuntime = vi.fn(async () => undefined);
    const registry = new IpcOperationRegistry();
    let operationSignal: AbortSignal | undefined;
    const running = registry.run(1, { requestId: 'settings-save-1' }, (signal) => {
      operationSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    await vi.waitFor(() => expect(operationSignal).toBeDefined());
    const cancel = registry.cancel(1, 'settings-save-1');
    await expect(running).rejects.toThrow('operation canceled');
    await expect(cancel).resolves.toBe(true);
    expect(stopRuntime).not.toHaveBeenCalled();
  });
});
