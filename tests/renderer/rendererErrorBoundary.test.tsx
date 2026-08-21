// @vitest-environment jsdom

import React, { Suspense, lazy } from 'react';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RendererErrorBoundary,
  createRendererErrorCode,
  reportRendererError
} from '../../src/renderer/components/RendererErrorBoundary';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

function ThrowingView({ message }: { message: string }): never {
  throw new Error(message);
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  Object.defineProperty(window, 'youyu', { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

describe('RendererErrorBoundary', () => {
  it('shows retry and diagnostic actions without exposing private error details', async () => {
    const privateDetail = 'token=secret C:\\Users\\Fishknowsss\\private https://private.example/path';
    const retry = vi.fn();
    const exportDiagnostics = vi.fn(async () => ({ canceled: false, filePath: 'C:\\safe.zip' }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: { exportDiagnostics } as unknown as NonNullable<Window['youyu']>
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        <RendererErrorBoundary onRetry={retry}>
          <ThrowingView message={privateDetail} />
        </RendererErrorBoundary>
      )
    );

    expect(container.textContent).toContain('页面暂时无法显示');
    expect(container.textContent).not.toContain(privateDetail);
    expect(container.textContent).not.toContain('Fishknowsss');

    await act(async () => findButton(container, '导出诊断')?.click());
    expect(exportDiagnostics).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('诊断已导出');

    await act(async () => findButton(container, '重试')?.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('catches a rejected lazy module and keeps its failure details out of the page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const LazyFailure = lazy(async () => Promise.reject(new Error('chunk failed token=secret')));
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        <RendererErrorBoundary onRetry={() => undefined}>
          <Suspense fallback={<div>正在加载</div>}>
            <LazyFailure />
          </Suspense>
        </RendererErrorBoundary>
      )
    );

    expect(container.textContent).toContain('页面暂时无法显示');
    expect(container.textContent).not.toContain('token=secret');
    expect(findButton(container, '重试')).toBeTruthy();
  });

  it('reports only a stable code rather than the raw error or stack', () => {
    const privateDetail = 'Bearer secret-token C:\\Users\\Fishknowsss\\private';
    const error = new Error(privateDetail);
    const output: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => output.push(args));

    const code = createRendererErrorCode(error);
    reportRendererError(error);
    const serialized = JSON.stringify(output);

    expect(code).toMatch(/^R-[A-F0-9]{8}$/);
    expect(serialized).toContain(code);
    expect(serialized).not.toContain(privateDetail);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('Fishknowsss');
  });

  it('wraps every renderer role and lazy pet load without a top-level module await', () => {
    const source = readFileSync('src/renderer/main.tsx', 'utf8');

    expect(source).toContain('<RendererErrorBoundary>');
    expect(source).toContain('<RendererRoot />');
    expect(source).toContain('lazy(async () =>');
    expect(source).not.toContain('const RootComponent = await');
  });
});

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text);
}
