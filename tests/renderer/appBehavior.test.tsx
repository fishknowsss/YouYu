// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationRequestTracker,
  getActionErrorMessage,
  RegistrationGate,
  startEasyProxy,
  withTimeout
} from '../../src/renderer/App';
import type { AppSnapshot } from '../../src/shared/ipc';
import { AppShell } from '../../src/renderer/components/AppShell';
import { Home } from '../../src/renderer/pages/Home';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe('renderer action behavior', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the operation that timed out and requests cancellation', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pending = withTimeout(new Promise<never>(() => undefined), 50, '同步', onTimeout);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'ActionTimeoutError',
      operation: '同步'
    });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    expect(onTimeout).toHaveBeenCalledOnce();
    await expect(withTimeout(Promise.resolve('ok'), 50, '启动', onTimeout)).resolves.toBe('ok');
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('keeps generic and operation-specific timeout copy separate', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => undefined), 1, '修复');
    let timeoutError: unknown;
    void pending.catch((error) => {
      timeoutError = error;
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(getActionErrorMessage(timeoutError)).toBe('修复超时');
    expect(getActionErrorMessage(new Error('operation timed out'))).toBe('操作超时');
  });

  it('does not start the proxy when cancellation lands during the snapshot gap', async () => {
    let resolveSnapshot: ((snapshot: AppSnapshot) => void) | undefined;
    const snapshot = new Promise<AppSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const start = vi.fn();
    const controller = new AbortController();
    const api = {
      getSnapshot: vi.fn(() => snapshot),
      start
    } as unknown as NonNullable<Window['youyu']>;
    const running = startEasyProxy(api, createOperationRequestTracker(), controller.signal);

    controller.abort(new Error('operation canceled'));
    resolveSnapshot?.({ status: 'stopped' } as AppSnapshot);

    await expect(running).rejects.toThrow('operation canceled');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('RegistrationGate', () => {
  it('renders a labelled modal form that requires both fields', () => {
    const html = renderToStaticMarkup(<RegistrationGate busy={false} message="" onRegister={() => undefined} />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="registration-title"');
    expect(html).toContain('aria-describedby="registration-description registration-status"');
    expect(html).toContain('填写姓名和口令后开始使用');
    expect(html.match(/required=""/g)).toHaveLength(2);
    expect(html).toContain('type="submit"');
  });

  it('exposes the registration progress as an atomic live region', () => {
    const html = renderToStaticMarkup(<RegistrationGate busy message="" onRegister={() => undefined} />);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('登记中');
  });

  it('focuses the first field and traps forward and reverse tab navigation', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<RegistrationGate busy={false} message="" onRegister={() => undefined} />));

    const name = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    const passphrase = container.querySelector<HTMLInputElement>('input[name="registration-passphrase"]')!;
    expect(document.activeElement).toBe(name);

    passphrase.focus();
    passphrase.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(name);

    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(passphrase);
  });

  it('keeps the background inert while registration is required', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AppShell page="home" usageMode="easy" inert onPageChange={() => undefined}>
          <main>受限内容</main>
        </AppShell>
      )
    );

    const shell = container.querySelector('.app-shell');
    expect(shell?.hasAttribute('inert')).toBe(true);
    expect(shell?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('advanced home diagnostics', () => {
  it('keeps the diagnostics viewport on the latest log entry', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const snapshot = {
      status: 'running',
      currentNode: '自动选择',
      traffic: {
        todayUpload: 0,
        todayDownload: 0,
        totalUpload: 0,
        totalDownload: 0,
        nodeUsage: {}
      },
      diagnostics: {
        logs: ['日志 1', '日志 2', '日志 3', '日志 4', '日志 5', '日志 6', '重复日志']
      },
      strategy: 'auto',
      mode: 'rule',
      nodeHealth: {
        delayStatus: 'untested',
        availability: { status: 'untested', totalCount: 10 }
      }
    } as AppSnapshot;
    const props = {
      usageMode: 'advanced' as const,
      snapshot,
      busy: false,
      busyLabel: '',
      message: '',
      onQuickStart: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onRepair: vi.fn(),
      onModeChange: vi.fn(),
      onStrategyChange: vi.fn(),
      onOpenNodes: vi.fn(),
      onUsageModeChange: vi.fn(),
      onInstallUpdate: vi.fn()
    };

    await act(async () => root?.render(<Home {...props} />));
    expect(container.querySelector('.mode-strip button[aria-pressed="true"]')?.textContent).toBe('规则');
    expect(container.querySelector('.node-mode-toggle button[aria-pressed="true"]')?.textContent).toBe('自动');
    const log = container.querySelector<HTMLDivElement>('.diagnostics-log')!;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 240 });

    await act(async () =>
      root?.render(
        <Home
          {...props}
          snapshot={{
            ...snapshot,
            diagnostics: { logs: [...snapshot.diagnostics.logs, '重复日志'] }
          }}
        />
      )
    );

    expect(log.scrollTop).toBe(240);
    expect(log.lastElementChild?.textContent).toBe('重复日志');
  });
});
