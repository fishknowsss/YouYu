// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevYouYuApi } from '../../src/renderer/devApi';
import { NodeSelect } from '../../src/renderer/pages/NodeSelect';
import { resetConnectivityCacheForTests, TestPage } from '../../src/renderer/pages/TestPage';
import type { AppSnapshot, ConnectivityServiceKey, OperationRequest } from '../../src/shared/ipc';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  Object.defineProperty(window, 'youyu', { configurable: true, value: undefined });
  resetConnectivityCacheForTests();
});

describe('testing interactions', () => {
  it('keeps node selection clickable while the all-node speed test is running', async () => {
    const snapshot = await createRunningSnapshot();
    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        <NodeSelect
          snapshot={snapshot}
          busy
          message="测速中"
          testingAll
          onSelect={onSelect}
          onTestNode={() => undefined}
          onTestAll={() => undefined}
          onCancelTestAll={() => undefined}
          onRefresh={() => undefined}
        />
      )
    );

    const nodeButton = container.querySelector<HTMLButtonElement>('.node-main');
    expect(nodeButton?.disabled).toBe(false);
    await act(async () => nodeButton?.click());
    expect(onSelect).toHaveBeenCalledWith('日本 01');
    expect(container.querySelector<HTMLButtonElement>('.node-test')?.disabled).toBe(true);

    await act(async () =>
      root?.render(
        <NodeSelect
          snapshot={snapshot}
          busy
          message="切换中"
          testingAll
          switchingNode="日本 01"
          onSelect={onSelect}
          onTestNode={() => undefined}
          onTestAll={() => undefined}
          onCancelTestAll={() => undefined}
          onRefresh={() => undefined}
        />
      )
    );
    expect([...container.querySelectorAll<HTMLButtonElement>('.node-main')].every((button) => button.disabled)).toBe(
      true
    );
  });

  it('stops an all-site test, cancels in-flight probes, and does not start more work', async () => {
    const snapshot = await createRunningSnapshot();
    const pending = new Map<string, (error: Error) => void>();
    const testConnectivity = vi.fn(
      (_key: ConnectivityServiceKey, request?: OperationRequest) =>
        new Promise<never>((_resolve, reject) => {
          if (request) pending.set(request.requestId, reject);
        })
    );
    const cancelOperation = vi.fn(async (requestId: string) => {
      pending.get(requestId)?.(new Error('operation canceled'));
      return true;
    });
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: { testConnectivity, cancelOperation } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<TestPage snapshot={snapshot} />));
    const startButton = findButton(container, '测全部');
    await act(async () => {
      startButton?.click();
      await Promise.resolve();
    });

    expect(testConnectivity).toHaveBeenCalledTimes(1);
    expect(testConnectivity.mock.calls[0]?.[0]).toBe('steam');
    const stopButton = findButton(container, '停止');
    expect(stopButton?.disabled).toBe(false);

    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(cancelOperation).toHaveBeenCalledTimes(1);
    expect(testConnectivity).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.test-status.testing')).toHaveLength(0);
    expect(findButton(container, '测全部')?.disabled).toBe(false);
  });
});

async function createRunningSnapshot(): Promise<AppSnapshot> {
  const snapshot = await createDevYouYuApi().getSnapshot();
  return {
    ...snapshot,
    status: 'running',
    currentNode: '日本 01',
    nodes: [
      { name: '日本 01', active: true, delay: 86, testState: 'testing' },
      { name: '香港 01', active: false, delay: 112, testState: 'testing' }
    ]
  };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text);
}
