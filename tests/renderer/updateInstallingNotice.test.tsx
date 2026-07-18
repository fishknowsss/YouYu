// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevYouYuApi } from '../../src/renderer/devApi';
import { Home } from '../../src/renderer/pages/Home';
import { Settings } from '../../src/renderer/pages/Settings';
import type { AppSnapshot } from '../../src/shared/ipc';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe('silent update installation notice', () => {
  it('keeps a clear no-action-required message visible in easy mode', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Home {...createHomeProps(await createInstallingSnapshot())} />));

    expect(container.textContent).toContain('已开始自动安装');
    expect(container.textContent).toContain('无需操作');
    expect(container.textContent).toContain('即将重启');
    expect(findButton(container, '安装')).toBeUndefined();
  });

  it('shows the same handoff message in the settings update row', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        <Settings
          snapshot={await createInstallingSnapshot()}
          busy
          busyLabel="安装中"
          message=""
          onRepair={() => undefined}
          onSave={() => undefined}
          onSyncRemoteConfig={() => undefined}
          onExportDiagnostics={() => undefined}
          onCheckUpdate={() => undefined}
          onInstallUpdate={() => undefined}
        />
      )
    );

    expect(container.textContent).toContain('已开始自动安装，无需操作');
    expect(findButton(container, '安装中')?.disabled).toBe(true);
  });

  it('restores an actionable install button when the silent handoff fails', async () => {
    const snapshot = await createInstallingSnapshot();
    snapshot.update = {
      ...snapshot.update,
      status: 'downloaded',
      downloadedVersion: '1.6.5',
      message: '启动安装器失败: spawn failed'
    };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Home {...createHomeProps(snapshot)} busy={false} busyLabel="" />));

    expect(container.textContent).toContain('安装未开始，请重试');
    expect(findButton(container, '安装')?.disabled).toBe(false);
  });
});

async function createInstallingSnapshot(): Promise<AppSnapshot> {
  const snapshot = await createDevYouYuApi().getSnapshot();
  return {
    ...snapshot,
    update: {
      ...snapshot.update,
      status: 'installing',
      message: '已开始自动安装，无需操作'
    }
  };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text);
}

function createHomeProps(snapshot: AppSnapshot) {
  return {
    usageMode: 'easy' as const,
    snapshot,
    busy: true,
    busyLabel: '安装中',
    message: '',
    onQuickStart: () => undefined,
    onStart: () => undefined,
    onStop: () => undefined,
    onRepair: () => undefined,
    onModeChange: () => undefined,
    onStrategyChange: () => undefined,
    onOpenNodes: () => undefined,
    onUsageModeChange: () => undefined,
    onInstallUpdate: () => undefined
  };
}
