// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevYouYuApi } from '../../src/renderer/devApi';
import { NodeSelect } from '../../src/renderer/pages/NodeSelect';
import { resetConnectivityCacheForTests, TestPage } from '../../src/renderer/pages/TestPage';
import type { AppSnapshot, ConnectivityResult, ConnectivityServiceKey, OperationRequest } from '../../src/shared/ipc';

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
  it('exposes the connectivity grid with table, header, row-group, and cell semantics', async () => {
    const snapshot = await createRunningSnapshot();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<TestPage snapshot={snapshot} />));

    const table = container.querySelector<HTMLElement>('[role="table"]');
    const rowGroups = [...(table?.children ?? [])].filter((element) => element.getAttribute('role') === 'rowgroup');
    const columnHeaders = table?.querySelectorAll('[role="columnheader"]');
    const dataRows = rowGroups[1]?.querySelectorAll<HTMLElement>(':scope > [role="row"]') ?? [];

    expect(rowGroups).toHaveLength(2);
    expect(columnHeaders).toHaveLength(8);
    expect(dataRows.length).toBeGreaterThan(0);
    for (const row of dataRows) {
      const cells = [...row.children].filter((element) => element.getAttribute('role') === 'cell');
      expect(cells).toHaveLength(8);
      expect(cells.at(-1)?.querySelector('button.test-retry')).not.toBeNull();
    }
  });

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

  it('keeps different single-service retries independently owned until both complete', async () => {
    const snapshot = await createRunningSnapshot();
    const pending = new Map<ConnectivityServiceKey, ReturnType<typeof deferred<ConnectivityResult>>>();
    const testConnectivity = vi.fn((key: ConnectivityServiceKey) => {
      const operation = deferred<ConnectivityResult>();
      pending.set(key, operation);
      return operation.promise;
    });
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: { testConnectivity, cancelOperation: vi.fn(async () => true) } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<TestPage snapshot={snapshot} />));
    const steamRetry = findServiceRetryButton(container, 'Steam');
    const chatGptRetry = findServiceRetryButton(container, 'ChatGPT');
    await act(async () => {
      steamRetry?.click();
      chatGptRetry?.click();
      await Promise.resolve();
    });

    expect(testConnectivity.mock.calls.map(([key]) => key)).toEqual(['steam', 'chatgpt']);
    expect(findServiceRow(container, 'Steam')?.querySelector('.test-status')?.textContent).toBe('测试中');
    expect(findServiceRow(container, 'ChatGPT')?.querySelector('.test-status')?.textContent).toBe('测试中');
    expect(findButton(container, '测全部')?.disabled).toBe(true);

    await act(async () => {
      pending.get('chatgpt')?.resolve(createConnectivityResult('chatgpt', 'ChatGPT', 73));
      await Promise.resolve();
    });
    expect(findServiceRow(container, 'ChatGPT')?.querySelector('.test-status')?.textContent).toBe('可用');
    expect(findServiceRow(container, 'Steam')?.querySelector('.test-status')?.textContent).toBe('测试中');

    await act(async () => {
      pending.get('steam')?.resolve(createConnectivityResult('steam', 'Steam', 91));
      await Promise.resolve();
    });
    expect(findServiceRow(container, 'Steam')?.querySelector('.test-status')?.textContent).toBe('可用');
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

function findServiceRow(container: HTMLElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('.route-test-row')].find(
    (row) => row.querySelector('.test-service-name')?.textContent === name
  );
}

function findServiceRetryButton(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return findServiceRow(container, name)?.querySelector<HTMLButtonElement>('.test-retry') ?? undefined;
}

function createConnectivityResult(key: ConnectivityServiceKey, name: string, totalMs: number): ConnectivityResult {
  return {
    key,
    name,
    url: `https://${key}.example.com`,
    status: 'available',
    statusText: '可用',
    reachability: 'ok',
    checkedAt: '2026-08-01T08:00:00.000Z',
    timings: { totalMs }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
