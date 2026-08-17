import { describe, expect, it, vi } from 'vitest';
import { runProxyStartSequence, type ProxyStartDeps } from '../../src/main/proxyStart';

describe('runProxyStartSequence', () => {
  it('returns as soon as the kernel is up and does not wait for preferred-node delay tests', async () => {
    let finishSelect!: () => void;
    const selectCanFinish = new Promise<void>((resolve) => {
      finishSelect = resolve;
    });
    const selectPreferredAutoNode = vi.fn(async () => {
      await selectCanFinish;
      return '🇯🇵 日本 01';
    });
    const deps = createDeps({ selectPreferredAutoNode });

    const snapshot = await runProxyStartSequence(deps);

    expect(snapshot.status).toBe('running');
    expect(deps.startLifecycle).toHaveBeenCalledOnce();
    expect(deps.createSnapshot).toHaveBeenCalledOnce();
    expect(selectPreferredAutoNode).toHaveBeenCalledOnce();
    expect(deps.stopLifecycle).not.toHaveBeenCalled();

    finishSelect();
    await vi.waitFor(() => {
      expect(deps.sendSnapshot).toHaveBeenCalledOnce();
    });
    expect(deps.appendLog).toHaveBeenCalledWith(expect.stringContaining('已自动选择可用节点'));
  });

  it('keeps the already-running proxy when background refinement fails', async () => {
    const selectPreferredAutoNode = vi.fn(async () => {
      throw new Error('没有可用的日本节点');
    });
    const deps = createDeps({ selectPreferredAutoNode });

    const snapshot = await runProxyStartSequence(deps);
    expect(snapshot.status).toBe('running');
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.stopLifecycle).not.toHaveBeenCalled();
    expect(deps.appendLog).toHaveBeenCalledWith(expect.stringContaining('继续使用当前节点'));
    expect(deps.recordStartError).not.toHaveBeenCalled();
  });

  it('does not start preferred-node refinement for manual strategy', async () => {
    const selectPreferredAutoNode = vi.fn();
    const deps = createDeps({
      selectPreferredAutoNode,
      readSettings: vi.fn(async () => ({ strategy: 'manual' as const }))
    });

    await runProxyStartSequence(deps);
    await Promise.resolve();

    expect(selectPreferredAutoNode).not.toHaveBeenCalled();
  });
});

function createDeps(overrides: Partial<ProxyStartDeps> = {}): ProxyStartDeps {
  return {
    throwIfAborted: () => undefined,
    throwIfNetworkRepairInProgress: () => undefined,
    requireTrafficIdentity: vi.fn(async () => undefined),
    requestStartIntent: vi.fn((requested?: number) => requested ?? 1),
    throwIfIntentCanceled: vi.fn(() => undefined),
    isIntentCurrent: vi.fn(() => true),
    syncRequiredRemoteConfig: vi.fn(async () => false),
    startLifecycle: vi.fn(async () => undefined),
    activatePending: vi.fn(async () => undefined),
    getRuntimeTrafficProxyUrl: vi.fn(() => 'http://127.0.0.1:7890'),
    stopLifecycle: vi.fn(async () => undefined),
    cancelIntent: vi.fn(() => undefined),
    createRefineSignal: vi.fn(() => undefined),
    readSettings: vi.fn(async () => ({ strategy: 'auto' as const })),
    selectPreferredAutoNode: vi.fn(async () => '🇯🇵 日本 01'),
    isExpectedCancellation: () => false,
    startTraffic: vi.fn(() => undefined),
    clearLastError: vi.fn(() => undefined),
    scheduleNodeHealthCheck: vi.fn(() => undefined),
    createSnapshot: vi.fn(async () => ({ status: 'running' }) as never),
    sendSnapshot: vi.fn(() => undefined),
    appendLog: vi.fn(() => undefined),
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    recordStartError: vi.fn(() => undefined),
    ...overrides
  };
}
