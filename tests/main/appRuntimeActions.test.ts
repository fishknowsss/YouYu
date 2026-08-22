import { describe, expect, it, vi } from 'vitest';
import { createAppRuntimeActions } from '../../src/main/appRuntimeActions';
import { RuntimeOperationError } from '../../src/main/runtimeRecoveryPolicy';

describe('AppRuntimeActions', () => {
  it('keeps start retry guards, intent checks, and diagnostics in their original order', async () => {
    const events: string[] = [];
    const start = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        events.push('start:1');
        throw new RuntimeOperationError('CORE_NOT_READY', 'not ready');
      })
      .mockImplementationOnce(async () => {
        events.push('start:2');
      });
    const actions = createAppRuntimeActions({
      start,
      restart: async () => undefined,
      throwIfNetworkRepairInProgress: (allow) => events.push(`repair:${String(allow)}`),
      throwIfRuntimeIntentCanceled: (generation) => events.push(`intent:${generation}`),
      appendLog: (message) => events.push(`log:${message}`),
      formatError: (error) => (error as Error).message
    });

    await actions.start(undefined, 7, { allowDuringNetworkRepair: true });

    expect(events).toEqual([
      'repair:true',
      'intent:7',
      'start:1',
      'repair:true',
      'intent:7',
      'log:启动遇到瞬时核心故障，正在安全重试一次 (CORE_NOT_READY): not ready',
      'start:2',
      'repair:true',
      'intent:7'
    ]);
  });

  it('binds one intent generation to subscription start and restart actions', async () => {
    const start = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    const assertIntent = vi.fn<(generation: number) => void>();
    const actions = createAppRuntimeActions({
      start,
      restart,
      throwIfNetworkRepairInProgress: vi.fn(),
      throwIfRuntimeIntentCanceled: assertIntent,
      appendLog: vi.fn(),
      formatError: String
    });
    const signal = new AbortController().signal;
    const bound = actions.forIntent(11);

    await bound.start(signal);
    await bound.restart(signal);

    expect(start).toHaveBeenCalledWith(signal);
    expect(restart).toHaveBeenCalledWith(signal);
    expect(assertIntent.mock.calls).toEqual([[11], [11], [11], [11]]);
  });
});
