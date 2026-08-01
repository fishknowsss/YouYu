import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUpdateCoordinator,
  normalizeUpdateSnapshot,
  type UpdateCheckResult
} from '../../src/main/updateCoordinator';
import type { AppUpdateSnapshot } from '../../src/shared/ipc';

describe('UpdateCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('normalizes status-specific fields and pins immutable build identity', () => {
    const downloaded: AppUpdateSnapshot = {
      currentVersion: '1.6.8',
      buildChannel: 'standard',
      updateChannel: 'latest',
      status: 'downloaded',
      availableVersion: '1.6.9',
      downloadedVersion: '1.6.9',
      percent: 100,
      message: 'old error'
    };

    expect(
      normalizeUpdateSnapshot(
        downloaded,
        {
          currentVersion: 'forged',
          buildChannel: 'no',
          updateChannel: 'latest-no',
          status: 'checking'
        },
        { currentVersion: '1.6.8', buildChannel: 'standard', updateChannel: 'latest' }
      )
    ).toEqual({
      currentVersion: '1.6.8',
      buildChannel: 'standard',
      updateChannel: 'latest',
      status: 'checking'
    });
  });

  it('retains the downloaded artifact identity while installing and after a failed handoff', () => {
    const harness = createHarness();
    harness.coordinator.setSnapshot({
      status: 'downloaded',
      availableVersion: '1.6.9',
      downloadedVersion: '1.6.9',
      percent: 100
    });

    harness.coordinator.setSnapshot({ status: 'installing', message: '正在准备静默安装' });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      status: 'installing',
      availableVersion: '1.6.9',
      downloadedVersion: '1.6.9',
      percent: 100
    });

    harness.coordinator.setSnapshot({ status: 'downloaded', message: '启动安装器失败' });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      status: 'downloaded',
      availableVersion: '1.6.9',
      downloadedVersion: '1.6.9',
      percent: 100,
      message: '启动安装器失败'
    });
  });

  it('singleflights checks and reports the real active operation', async () => {
    const pending = deferred<UpdateCheckResult>();
    const harness = createHarness({ executeCheck: vi.fn(() => pending.promise) });
    harness.coordinator.start({ checkImmediately: false });

    const first = harness.coordinator.check(true);
    const second = harness.coordinator.check(false);

    expect(second).toBe(first);
    expect(harness.executeCheck).toHaveBeenCalledOnce();
    expect(harness.coordinator.inspect()).toMatchObject({
      operation: 'checking',
      status: 'checking',
      checkInFlight: true,
      downloadInFlight: false
    });

    pending.resolve({ isUpdateAvailable: false, updateInfo: { version: '1.6.8' } });
    await first;

    expect(harness.coordinator.inspect()).toMatchObject({
      operation: 'idle',
      status: 'not-available',
      checkInFlight: false,
      timerScheduled: true
    });
  });

  it('singleflights downloads and normalizes progress and downloaded events', async () => {
    const pending = deferred<unknown>();
    const harness = createHarness({ executeDownload: vi.fn(() => pending.promise) });
    harness.coordinator.start({ checkImmediately: false });
    harness.coordinator.setSnapshot({ status: 'available', availableVersion: '1.6.9' });

    const first = harness.coordinator.download();
    const second = harness.coordinator.download();
    expect(second).toBe(first);
    expect(harness.executeDownload).toHaveBeenCalledOnce();
    expect(harness.coordinator.inspect()).toMatchObject({
      operation: 'downloading',
      status: 'downloading',
      downloadInFlight: true
    });

    harness.updater.emit('download-progress', {
      percent: 120.4,
      transferred: -5,
      total: 2048.8,
      bytesPerSecond: Number.NaN
    });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      status: 'downloading',
      percent: 100,
      totalBytes: 2049
    });
    expect(harness.coordinator.getSnapshot()).not.toHaveProperty('transferredBytes');
    expect(harness.coordinator.getSnapshot()).not.toHaveProperty('bytesPerSecond');

    harness.updater.emit('update-downloaded', { version: ' 1.6.9 ' });
    pending.resolve(['YouYu-1.6.9-x64.exe']);
    await first;

    expect(harness.coordinator.getSnapshot()).toMatchObject({
      status: 'downloaded',
      availableVersion: '1.6.9',
      downloadedVersion: '1.6.9',
      percent: 100
    });
    expect(harness.coordinator.inspect()).toMatchObject({ operation: 'idle', downloadInFlight: false });
  });

  it('prevents stale check results and events from replacing a newer terminal state', async () => {
    const pending = deferred<UpdateCheckResult>();
    const harness = createHarness({ executeCheck: vi.fn(() => pending.promise) });
    harness.coordinator.start({ checkImmediately: false });
    const checking = harness.coordinator.check();
    const oldGeneration = harness.coordinator.inspect().generation;

    harness.coordinator.setSnapshot({
      status: 'downloaded',
      availableVersion: '1.7.0',
      downloadedVersion: '1.7.0',
      percent: 100
    });
    expect(harness.coordinator.inspect().generation).toBeGreaterThan(oldGeneration);
    harness.updater.emit('update-available', { version: '1.6.9' });
    harness.updater.emit('update-not-available', { version: '1.6.8' });
    pending.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.6.9' } });
    await checking;

    expect(harness.coordinator.getSnapshot()).toMatchObject({
      status: 'downloaded',
      downloadedVersion: '1.7.0'
    });
    expect(harness.executeDownload).not.toHaveBeenCalled();
  });

  it('prevents stale download progress, completion and rejection from replacing installing', async () => {
    const pending = deferred<unknown>();
    const harness = createHarness({ executeDownload: vi.fn(() => pending.promise) });
    harness.coordinator.start({ checkImmediately: false });
    harness.coordinator.setSnapshot({ status: 'available', availableVersion: '1.6.9' });
    const downloading = harness.coordinator.download();

    harness.updater.emit('download-progress', { percent: 20, transferred: 20, total: 100 });
    expect(harness.coordinator.getSnapshot().status).toBe('downloading');
    harness.coordinator.setSnapshot({ status: 'installing', message: '正在安装更新' });
    harness.updater.emit('download-progress', { percent: 90, transferred: 90, total: 100 });
    harness.updater.emit('update-downloaded', { version: '1.6.9' });
    pending.reject(new Error('late download failure'));
    await downloading;

    expect(harness.coordinator.getSnapshot()).toMatchObject({
      status: 'installing',
      message: '正在安装更新'
    });
    expect(harness.logs).not.toContain('更新下载失败: late download failure');
  });

  it('keeps exactly one unref periodic timer and re-arms it after a check', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.coordinator.start({ checkImmediately: false });

    harness.coordinator.schedule(100);
    harness.coordinator.schedule(200);
    expect(vi.getTimerCount()).toBe(1);
    expect(harness.coordinator.inspect()).toMatchObject({ timerScheduled: true, timerUnrefed: true });

    await vi.advanceTimersByTimeAsync(199);
    expect(harness.executeCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.executeCheck).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('removes every updater listener and timer on dispose', () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.coordinator.start({ checkImmediately: false });
    harness.coordinator.schedule(500);

    for (const event of updateEvents) expect(harness.updater.listenerCount(event)).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    harness.coordinator.dispose();
    for (const event of updateEvents) expect(harness.updater.listenerCount(event)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.coordinator.inspect()).toMatchObject({
      disposed: true,
      operation: 'idle',
      checkInFlight: false,
      downloadInFlight: false,
      timerScheduled: false
    });
  });

  it('ignores a check that settles after dispose', async () => {
    const pending = deferred<UpdateCheckResult>();
    const harness = createHarness({ executeCheck: vi.fn(() => pending.promise) });
    harness.coordinator.start({ checkImmediately: false });
    const checking = harness.coordinator.check();
    harness.coordinator.dispose();

    pending.resolve({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' } });
    await checking;
    expect(harness.coordinator.getSnapshot().status).toBe('checking');
    expect(harness.executeDownload).not.toHaveBeenCalled();
  });

  it('recovers from check and download failures without preserving stale error fields', async () => {
    const executeCheck = vi
      .fn<() => Promise<UpdateCheckResult>>()
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: { version: '1.6.8' } });
    const executeDownload = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('asset unavailable'))
      .mockResolvedValueOnce(['YouYu-1.6.9-x64.exe']);
    const harness = createHarness({ executeCheck, executeDownload });
    harness.coordinator.start({ checkImmediately: false });

    await harness.coordinator.check();
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      status: 'failed',
      message: 'metadata unavailable'
    });
    await harness.coordinator.check();
    expect(harness.coordinator.getSnapshot()).toMatchObject({ status: 'not-available' });
    expect(harness.coordinator.getSnapshot()).not.toHaveProperty('message');

    harness.coordinator.setSnapshot({ status: 'available', availableVersion: '1.6.9' });
    await harness.coordinator.download();
    expect(harness.coordinator.getSnapshot()).toMatchObject({ status: 'failed', message: 'asset unavailable' });
    harness.coordinator.setSnapshot({ status: 'available', availableVersion: '1.6.9' });
    const recovered = harness.coordinator.download();
    harness.updater.emit('update-downloaded', { version: '1.6.9' });
    await recovered;
    expect(harness.coordinator.getSnapshot()).toMatchObject({ status: 'downloaded', percent: 100 });
    expect(harness.coordinator.getSnapshot()).not.toHaveProperty('message');
  });

  it('clears singleflight state when injected operations throw synchronously', async () => {
    const executeCheck = vi.fn<() => Promise<UpdateCheckResult>>(() => {
      throw new Error('synchronous check failure');
    });
    const executeDownload = vi.fn<() => Promise<unknown>>(() => {
      throw new Error('synchronous download failure');
    });
    const harness = createHarness({ executeCheck, executeDownload });
    harness.coordinator.start({ checkImmediately: false });

    await harness.coordinator.check();
    expect(harness.coordinator.inspect()).toMatchObject({ operation: 'idle', checkInFlight: false });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      status: 'failed',
      message: 'synchronous check failure'
    });

    harness.coordinator.setSnapshot({ status: 'available', availableVersion: '1.6.9' });
    await harness.coordinator.download();
    expect(harness.coordinator.inspect()).toMatchObject({ operation: 'idle', downloadInFlight: false });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      status: 'failed',
      message: 'synchronous download failure'
    });
  });

  it('settles check and download flights when snapshot observers throw', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = createHarness({
      onSnapshot: () => {
        throw new Error('snapshot observer failed');
      }
    });
    harness.coordinator.start({ checkImmediately: false });

    await expect(harness.coordinator.check()).resolves.toMatchObject({ status: 'not-available' });
    expect(harness.coordinator.inspect()).toMatchObject({ operation: 'idle', checkInFlight: false });

    harness.coordinator.setSnapshot({ status: 'available', availableVersion: '1.6.9' });
    await expect(harness.coordinator.download()).resolves.toMatchObject({ status: 'downloaded' });
    expect(harness.coordinator.inspect()).toMatchObject({ operation: 'idle', downloadInFlight: false });
    expect(consoleError).toHaveBeenCalledWith('update snapshot observer failed', expect.any(Error));
  });

  it('settles a failed flight when error formatting and logging observers throw', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = createHarness({
      executeCheck: vi.fn(async () => {
        throw new Error('metadata unavailable');
      }),
      formatError: () => {
        throw new Error('formatter failed');
      },
      onLog: () => {
        throw new Error('log observer failed');
      }
    });
    harness.coordinator.start({ checkImmediately: false });

    await expect(harness.coordinator.check()).resolves.toMatchObject({
      status: 'failed',
      message: 'metadata unavailable'
    });
    expect(harness.coordinator.inspect()).toMatchObject({ operation: 'idle', checkInFlight: false });
    expect(consoleError).toHaveBeenCalledWith('update error formatter failed', expect.any(Error));
    expect(consoleError).toHaveBeenCalledWith('update log observer failed', expect.any(Error));
  });

  it('routes updater errors to installer recovery without corrupting the downloaded snapshot', () => {
    const onInstallerError = vi.fn();
    const harness = createHarness({ isInstallerLaunchPending: () => true, onInstallerError });
    harness.coordinator.start({ checkImmediately: false });
    harness.coordinator.setSnapshot({ status: 'downloaded', downloadedVersion: '1.6.9', percent: 100 });
    const error = new Error('installer launch failed');

    harness.updater.emit('error', error);

    expect(onInstallerError).toHaveBeenCalledWith(error);
    expect(harness.coordinator.getSnapshot().status).toBe('downloaded');
  });

  it('contains an installer recovery observer failure inside the updater event', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = createHarness({
      isInstallerLaunchPending: () => true,
      onInstallerError: () => {
        throw new Error('installer observer failed');
      }
    });
    harness.coordinator.start({ checkImmediately: false });

    expect(() => harness.updater.emit('error', new Error('installer launch failed'))).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('update installer error observer failed', expect.any(Error));
  });
});

const updateEvents = [
  'checking-for-update',
  'update-available',
  'download-progress',
  'update-downloaded',
  'update-not-available',
  'error'
];

class FakeUpdater extends EventEmitter {}

type HarnessOptions = {
  executeCheck?: () => Promise<UpdateCheckResult>;
  executeDownload?: () => Promise<unknown>;
  formatError?: (error: unknown) => string;
  onLog?: (message: string) => void;
  onSnapshot?: (snapshot: AppUpdateSnapshot) => void;
  isInstallerLaunchPending?: () => boolean;
  onInstallerError?: (error: unknown) => void;
};

function createHarness(options: HarnessOptions = {}) {
  const updater = new FakeUpdater();
  const snapshots: AppUpdateSnapshot[] = [];
  const logs: string[] = [];
  const executeCheck = options.executeCheck ?? vi.fn(async () => ({ isUpdateAvailable: false }));
  const executeDownload = options.executeDownload ?? vi.fn(async () => []);
  let nowIndex = 0;
  const coordinator = createUpdateCoordinator({
    updater,
    currentVersion: '1.6.8',
    buildChannel: 'standard',
    updateChannel: 'latest',
    isPackaged: () => true,
    periodicIntervalMs: 1000,
    executeCheck,
    executeDownload,
    formatError: options.formatError ?? ((error) => (error instanceof Error ? error.message : String(error))),
    onLog: options.onLog ?? ((message) => logs.push(message)),
    onSnapshot: options.onSnapshot ?? ((snapshot) => snapshots.push(snapshot)),
    now: () => new Date(Date.UTC(2026, 6, 20, 0, 0, nowIndex++)).toISOString(),
    isInstallerLaunchPending: options.isInstallerLaunchPending,
    onInstallerError: options.onInstallerError
  });
  return { coordinator, updater, snapshots, logs, executeCheck, executeDownload };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
