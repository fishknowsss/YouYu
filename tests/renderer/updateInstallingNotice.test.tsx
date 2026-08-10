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
  it('shows the install freshness check before easy mode reports a real installation', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<EasyInstallGapHarness snapshot={await createDownloadedSnapshot()} />));

    const installButton = findButton(container, '安装');
    expect(installButton?.disabled).toBe(false);
    expect(container.querySelector('.update-activity-spinner')).toBeNull();

    await act(async () => installButton?.click());

    expect(container.textContent).toContain('正在确认最新版');
    expect(container.textContent).toContain('确认中');
    expect(container.textContent).not.toContain('已开始自动安装');
    const spinner = container.querySelector('.update-activity-spinner');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(spinner?.parentElement?.classList.contains('easy-update-action')).toBe(true);
    expect(findButton(container, '安装')).toBeUndefined();
  });

  it('shows the install freshness check before settings reports a real installation', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<SettingsInstallGapHarness snapshot={await createDownloadedSnapshot()} />));

    const installButton = findButton(container, '安装');
    expect(installButton?.disabled).toBe(false);

    await act(async () => installButton?.click());

    expect(container.textContent).toContain('正在确认最新版');
    expect(container.textContent).not.toContain('已开始自动安装');
    const confirmingButton = findButton(container, '确认中');
    expect(confirmingButton?.disabled).toBe(true);
    const spinner = container.querySelector('.update-activity-spinner');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(spinner?.parentElement?.classList.contains('update-action-group')).toBe(true);
    expect(confirmingButton?.querySelector('.update-activity-spinner')).toBeNull();
  });

  it('does not mistake another busy operation for update installation', async () => {
    const snapshot = await createDownloadedSnapshot();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Home {...createHomeProps(snapshot)} busy busyLabel="修复中" />));

    expect(findButton(container, '安装')?.disabled).toBe(true);
    expect(container.querySelector('.update-activity-spinner')).toBeNull();
    expect(container.textContent).not.toContain('已开始自动安装');

    await act(async () =>
      root?.render(
        <Settings
          snapshot={snapshot}
          busy
          busyLabel="修复中"
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

    expect(findButton(container, '安装')?.disabled).toBe(true);
    expect(container.querySelector('.update-activity-spinner')).toBeNull();
    expect(container.textContent).not.toContain('已开始自动安装');
  });

  it('keeps a clear no-action-required message visible in easy mode', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Home {...createHomeProps(await createInstallingSnapshot())} />));

    expect(container.textContent).toContain('已开始自动安装');
    expect(container.textContent).toContain('无需操作');
    expect(container.textContent).toContain('即将重启');
    const spinner = container.querySelector('.update-activity-spinner');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(spinner?.parentElement?.classList.contains('easy-update-action')).toBe(true);
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
    const installingButton = findButton(container, '安装中');
    expect(installingButton?.disabled).toBe(true);
    const spinner = container.querySelector('.update-activity-spinner');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(spinner?.parentElement?.classList.contains('update-action-group')).toBe(true);
    expect(installingButton?.querySelector('.update-activity-spinner')).toBeNull();
  });

  it.each([
    ['checking', undefined],
    ['downloading', 'verifying']
  ] as const)(
    'keeps %s activity immediately beside the action on both update surfaces',
    async (status, downloadPhase) => {
      const snapshot = await createDownloadedSnapshot();
      snapshot.update = {
        ...snapshot.update,
        status,
        availableVersion: '1.6.10',
        downloadedVersion: undefined,
        downloadPhase,
        percent: status === 'downloading' ? 100 : undefined
      };
      const container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);

      await act(async () => root?.render(<Home {...createHomeProps(snapshot)} busy={false} busyLabel="" />));

      const easySpinner = container.querySelector('.update-activity-spinner');
      expect(easySpinner?.parentElement?.classList.contains('easy-update-action')).toBe(true);
      expect(container.querySelector('button .update-activity-spinner')).toBeNull();

      await act(async () =>
        root?.render(
          <Settings
            snapshot={snapshot}
            busy={false}
            busyLabel=""
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

      const settingsSpinner = container.querySelector('.update-activity-spinner');
      expect(settingsSpinner?.parentElement?.classList.contains('update-action-group')).toBe(true);
      expect(container.querySelector('button .update-activity-spinner')).toBeNull();
    }
  );

  it('shows an immediate animated check state after manually requesting an update', async () => {
    const snapshot = await createDownloadedSnapshot();
    snapshot.update = { ...snapshot.update, status: 'idle', downloadedVersion: undefined };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        <Settings
          snapshot={snapshot}
          busy
          busyLabel="检查中"
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

    expect(container.querySelector('.update-row')?.getAttribute('aria-busy')).toBe('true');
    expect(findButton(container, '检查中')?.disabled).toBe(true);
    const spinner = container.querySelector('.update-activity-spinner');
    expect(spinner?.parentElement?.classList.contains('update-action-group')).toBe(true);
    expect(spinner?.nextElementSibling?.tagName).toBe('BUTTON');
  });

  it('restores an actionable install button when the silent handoff fails', async () => {
    const snapshot = await createInstallingSnapshot();
    snapshot.update = {
      ...snapshot.update,
      status: 'downloaded',
      downloadedVersion: '1.6.5',
      message: '启动安装器失败: spawn failed',
      failureKind: 'installer-launch-failed'
    };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Home {...createHomeProps(snapshot)} busy={false} busyLabel="" />));

    expect(container.textContent).toContain('安装未开始，请重试');
    expect(findButton(container, '安装')?.disabled).toBe(false);
  });

  it('shows the automatic download route switch on both update surfaces', async () => {
    const snapshot = await createDownloadedSnapshot();
    snapshot.update = {
      ...snapshot.update,
      status: 'downloading',
      downloadedVersion: undefined,
      availableVersion: '1.7.4',
      percent: 18,
      transferredBytes: 18 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      message: '线路不稳定，已自动切换重试'
    };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Home {...createHomeProps(snapshot)} busy={false} busyLabel="" />));
    expect(container.textContent).toContain('线路不稳定，已自动切换重试');
    expect(container.textContent).toContain('18.0MB / 100.0MB');

    await act(async () =>
      root?.render(
        <Settings
          snapshot={snapshot}
          busy={false}
          busyLabel=""
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
    expect(container.textContent).toContain('线路不稳定，已自动切换重试');
  });

  it('distinguishes a freshness-check failure from an installer launch failure', async () => {
    const snapshot = await createDownloadedSnapshot();
    snapshot.update = {
      ...snapshot.update,
      message: '检查新版失败: net::ERR_CONNECTION_TIMED_OUT',
      failureKind: 'refresh-check-failed'
    };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Home {...createHomeProps(snapshot)} busy={false} busyLabel="" />));
    expect(container.textContent).toContain('未能确认最新版，请重试');
    expect(container.textContent).not.toContain('安装未开始');

    await act(async () =>
      root?.render(
        <Settings
          snapshot={snapshot}
          busy={false}
          busyLabel=""
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
    expect(container.textContent).toContain('未能确认最新版，请重试');
    expect(container.textContent).not.toContain('安装未开始');
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

async function createDownloadedSnapshot(): Promise<AppSnapshot> {
  const snapshot = await createDevYouYuApi().getSnapshot();
  return {
    ...snapshot,
    update: {
      ...snapshot.update,
      status: 'downloaded',
      downloadedVersion: '1.6.9',
      message: undefined
    }
  };
}

function EasyInstallGapHarness({ snapshot }: { snapshot: AppSnapshot }) {
  const [installRequested, setInstallRequested] = React.useState(false);
  return (
    <Home
      {...createHomeProps(snapshot)}
      busy={installRequested}
      busyLabel={installRequested ? '确认新版中' : ''}
      onInstallUpdate={() => setInstallRequested(true)}
    />
  );
}

function SettingsInstallGapHarness({ snapshot }: { snapshot: AppSnapshot }) {
  const [installRequested, setInstallRequested] = React.useState(false);
  return (
    <Settings
      snapshot={snapshot}
      busy={installRequested}
      busyLabel={installRequested ? '确认新版中' : ''}
      message=""
      onRepair={() => undefined}
      onSave={() => undefined}
      onSyncRemoteConfig={() => undefined}
      onExportDiagnostics={() => undefined}
      onCheckUpdate={() => undefined}
      onInstallUpdate={() => setInstallRequested(true)}
    />
  );
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
