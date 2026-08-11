// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type { AppSnapshot, OperationRequest } from '../../src/shared/ipc';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  Object.defineProperty(window, 'youyu', { configurable: true, value: undefined });
  window.history.replaceState({}, '', '/');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('App renderer lifecycle', () => {
  it('fetches the initial snapshot once under React StrictMode', async () => {
    const snapshot = createRegisteredRendererSnapshot();
    const getSnapshot = vi.fn(async () => snapshot);
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot,
        onSnapshotUpdated: vi.fn(() => vi.fn())
      } as unknown as NonNullable<Window['youyu']>
    });

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>
      );
    });

    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not issue a second initial snapshot request when the first one fails', async () => {
    const getSnapshot = vi.fn(async () => {
      throw new Error('initial snapshot failed');
    });
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot,
        onSnapshotUpdated: vi.fn(() => vi.fn())
      } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>
      );
    });

    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(container.querySelector('.registration-gate')).toBeTruthy();
  });

  it('keeps at most one snapshot subscription and releases it on unmount', async () => {
    const snapshot = createRegisteredRendererSnapshot();
    let activeSubscriptions = 0;
    let maximumActiveSubscriptions = 0;
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot: vi.fn(async () => snapshot),
        onSnapshotUpdated: vi.fn(() => {
          activeSubscriptions += 1;
          maximumActiveSubscriptions = Math.max(maximumActiveSubscriptions, activeSubscriptions);
          return () => {
            activeSubscriptions -= 1;
          };
        })
      } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>
      );
    });

    expect(maximumActiveSubscriptions).toBe(1);
    expect(activeSubscriptions).toBe(1);

    await act(async () => root?.unmount());
    root = undefined;
    expect(activeSubscriptions).toBe(0);
  });

  it('keeps one global shortcut listener across usage-mode changes and removes it on unmount', async () => {
    const snapshot = createRegisteredRendererSnapshot();
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot: vi.fn(async () => snapshot),
        onSnapshotUpdated: vi.fn(() => vi.fn())
      } as unknown as NonNullable<Window['youyu']>
    });
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));

    await act(async () => {
      for (const code of [
        'ArrowUp',
        'ArrowUp',
        'ArrowDown',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'ArrowLeft',
        'ArrowRight',
        'KeyB',
        'KeyA'
      ]) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      }
    });

    expect(addEventListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

    await act(async () => root?.unmount());
    root = undefined;
    expect(removeEventListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
  });

  it('cancels an active cancellable action when the renderer unmounts', async () => {
    window.history.replaceState({}, '', '/?mode=advanced');
    const snapshot = { ...createRegisteredRendererSnapshot(), status: 'stopped' as const };
    let resolveStart: ((value: AppSnapshot) => void) | undefined;
    let startRequest: OperationRequest | undefined;
    const start = vi.fn(
      (request?: OperationRequest) =>
        new Promise<AppSnapshot>((resolve) => {
          startRequest = request;
          resolveStart = resolve;
        })
    );
    const cancelOperation = vi.fn(async () => true);
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot: vi.fn(async () => snapshot),
        onSnapshotUpdated: vi.fn(() => vi.fn()),
        start,
        cancelOperation
      } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.power-button')?.click();
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledOnce();
    const requestId = startRequest?.requestId;

    await act(async () => root?.unmount());
    root = undefined;

    expect(cancelOperation).toHaveBeenCalledOnce();
    expect(cancelOperation).toHaveBeenCalledWith(requestId);
    await act(async () => {
      resolveStart?.({ ...snapshot, status: 'running' });
      await Promise.resolve();
    });
  });

  it('does not recover or update from an action that rejects after unmount', async () => {
    window.history.replaceState({}, '', '/?mode=advanced');
    const snapshot = { ...createRegisteredRendererSnapshot(), status: 'stopped' as const };
    let rejectStart: ((reason: Error) => void) | undefined;
    const start = vi.fn(
      () =>
        new Promise<AppSnapshot>((_resolve, reject) => {
          rejectStart = reject;
        })
    );
    const getSnapshot = vi.fn(async () => snapshot);
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot,
        onSnapshotUpdated: vi.fn(() => vi.fn()),
        start,
        cancelOperation: vi.fn(async () => true)
      } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.power-button')?.click();
      await Promise.resolve();
    });
    await act(async () => root?.unmount());
    root = undefined;
    await act(async () => {
      rejectStart?.(new Error('late failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSnapshot).toHaveBeenCalledOnce();
  });

  it('clears an active action timeout when the renderer unmounts', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/?mode=advanced');
    const snapshot = { ...createRegisteredRendererSnapshot(), status: 'stopped' as const };
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot: vi.fn(async () => snapshot),
        onSnapshotUpdated: vi.fn(() => vi.fn()),
        start: vi.fn(() => new Promise<AppSnapshot>(() => undefined)),
        cancelOperation: vi.fn(async () => true)
      } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    const baselineTimerCount = vi.getTimerCount();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.power-button')?.click();
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

    await act(async () => root?.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });

  it('cancels the quick-start request and node testing when unmounted', async () => {
    vi.useFakeTimers();
    const snapshot = { ...createRegisteredRendererSnapshot(), status: 'stopped' as const };
    let saveRequest: OperationRequest | undefined;
    const saveSettings = vi.fn((_: unknown, intent: string, request?: OperationRequest) => {
      expect(intent).toBe('easy-start');
      saveRequest = request;
      return new Promise<AppSnapshot>(() => undefined);
    });
    const cancelOperation = vi.fn(async () => true);
    const cancelNodeTests = vi.fn(async () => snapshot);
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot: vi.fn(async () => snapshot),
        onSnapshotUpdated: vi.fn(() => vi.fn()),
        saveSettings,
        cancelOperation,
        cancelNodeTests
      } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    const baselineTimerCount = vi.getTimerCount();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.easy-power-button')?.click();
      await Promise.resolve();
    });
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(saveSettings.mock.calls[0]?.[0]).not.toHaveProperty('ruleProfile');
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

    await act(async () => root?.unmount());
    root = undefined;

    expect(cancelOperation).toHaveBeenCalledOnce();
    expect(cancelOperation).toHaveBeenCalledWith(saveRequest?.requestId);
    expect(cancelNodeTests).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });

  it('requests cancellation once when a cancellable action times out', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/?mode=advanced');
    const snapshot = { ...createRegisteredRendererSnapshot(), status: 'stopped' as const };
    let startRequest: OperationRequest | undefined;
    const start = vi.fn((request?: OperationRequest) => {
      startRequest = request;
      return new Promise<AppSnapshot>(() => undefined);
    });
    const cancelOperation = vi.fn(async () => true);
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot: vi.fn(async () => snapshot),
        onSnapshotUpdated: vi.fn(() => vi.fn()),
        start,
        cancelOperation
      } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.power-button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });

    expect(cancelOperation).toHaveBeenCalledOnce();
    expect(cancelOperation).toHaveBeenCalledWith(startRequest?.requestId);
  });
});

function createRegisteredRendererSnapshot(): AppSnapshot {
  return {
    status: 'running',
    currentNode: '自动选择',
    nodes: [],
    nodeHealth: {
      nodeName: '自动选择',
      delayStatus: 'untested',
      availability: { status: 'untested', totalCount: 0 }
    },
    strategies: [],
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'ruleset',
    features: {
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled: false,
      strictRouteEnabled: true,
      allowLan: false,
      subscriptionRefreshIntervalHours: 12
    },
    runtime: { activeConnections: 0, uploadTotal: 0, downloadTotal: 0 },
    traffic: {
      totalUpload: 0,
      totalDownload: 0,
      todayUpload: 0,
      todayDownload: 0,
      pendingUpload: 0,
      pendingDownload: 0,
      nodeUsage: {},
      reportStatus: 'idle'
    },
    trafficIdentity: {
      userId: 'user-1',
      deviceId: 'device-1',
      name: '测试用户',
      registeredAt: '2026-07-15T00:00:00.000Z'
    },
    subscriptionUrl: 'https://example.com/subscription',
    subscriptionRevision: 1,
    update: {
      currentVersion: '1.6.5',
      buildChannel: 'standard',
      updateChannel: 'latest',
      status: 'idle'
    },
    diagnostics: { logs: ['运行正常'], logCount: 1 }
  };
}
