import type { AppBuildChannel, AppUpdateSnapshot } from '../shared/ipc';
import { getUpdateDownloadPhase, normalizeUpdateBytes } from '../shared/updateProgress';

export type UpdateCheckResult = {
  isUpdateAvailable?: boolean;
  updateInfo?: unknown;
} | null;

type UpdateEventName =
  | 'checking-for-update'
  | 'update-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'update-not-available'
  | 'error';

type UpdateEventListener = (...args: unknown[]) => void;

export type UpdateEventSource = {
  on: (event: UpdateEventName, listener: UpdateEventListener) => unknown;
  removeListener: (event: UpdateEventName, listener: UpdateEventListener) => unknown;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type UpdateCoordinatorOptions = {
  updater: UpdateEventSource;
  currentVersion: string;
  buildChannel: AppBuildChannel;
  updateChannel: string;
  isPackaged: () => boolean;
  periodicIntervalMs: number;
  executeCheck: () => Promise<UpdateCheckResult>;
  executeDownload: () => Promise<unknown>;
  formatError: (error: unknown) => string;
  onLog?: (message: string) => void;
  onSnapshot?: (snapshot: AppUpdateSnapshot) => void;
  now?: () => string;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  isInstallerLaunchPending?: () => boolean;
  onInstallerError?: (error: unknown) => void;
};

export type UpdateCoordinatorInspection = {
  started: boolean;
  disposed: boolean;
  generation: number;
  operation: 'idle' | 'checking' | 'downloading';
  status: AppUpdateSnapshot['status'];
  checkInFlight: boolean;
  downloadInFlight: boolean;
  timerScheduled: boolean;
  timerUnrefed: boolean;
};

export type UpdateInstallPreparation =
  | { ready: true; snapshot: AppUpdateSnapshot }
  | {
      ready: false;
      reason: 'not-downloaded' | 'newer-update' | 'check-failed';
      snapshot: AppUpdateSnapshot;
    };

type UpdateCheckFlight = {
  generation: number;
  promise: Promise<AppUpdateSnapshot>;
  userInitiated: boolean;
};

const updateRefreshFailurePrefix = '检查新版失败: ';

export function createUpdateCoordinator(options: UpdateCoordinatorOptions) {
  let snapshot: AppUpdateSnapshot = normalizeUpdateSnapshot(
    {
      currentVersion: options.currentVersion,
      buildChannel: options.buildChannel,
      updateChannel: options.updateChannel,
      status: 'idle'
    },
    {},
    options
  );
  let started = false;
  let disposed = false;
  let generation = 0;
  let activeCheckGeneration: number | undefined;
  let activeCheckPublishesEvents = false;
  let activeDownloadGeneration: number | undefined;
  let checkFlight: UpdateCheckFlight | undefined;
  let downloadFlight: { generation: number; promise: Promise<AppUpdateSnapshot> } | undefined;
  let periodicTimer: TimerHandle | undefined;
  let timerUnrefed = false;
  const listeners = createListeners();
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));

  function start(startOptions: { checkImmediately?: boolean } = {}): void {
    if (started || disposed) return;
    started = true;
    for (const [event, listener] of listeners) options.updater.on(event, listener);
    if (startOptions.checkImmediately !== false) {
      try {
        void check(false);
      } catch (error) {
        reportInternalError('update check start failed', error);
      }
    }
  }

  function check(userInitiated = true): Promise<AppUpdateSnapshot> {
    if (disposed) return Promise.resolve(snapshot);
    if (!options.isPackaged()) {
      const nextGeneration = ++generation;
      commit(
        {
          status: 'not-available',
          checkedAt: now(),
          message: userInitiated ? '开发环境不检查更新' : undefined
        },
        nextGeneration
      );
      return Promise.resolve(snapshot);
    }
    if (snapshot.status === 'installing') return Promise.resolve(snapshot);
    if (checkFlight) {
      if (userInitiated) checkFlight.userInitiated = true;
      return checkFlight.promise;
    }
    if (downloadFlight) return Promise.resolve(snapshot);

    clearPeriodicTimer();
    const previousSnapshot = snapshot;
    const preserveDownloaded = previousSnapshot.status === 'downloaded';
    const operationGeneration = ++generation;
    activeCheckGeneration = operationGeneration;
    activeCheckPublishesEvents = userInitiated && !preserveDownloaded;
    if (activeCheckPublishesEvents) {
      commit({ status: 'checking', checkedAt: now() }, operationGeneration);
    }
    let resolveFlight!: (value: AppUpdateSnapshot) => void;
    const promise = new Promise<AppUpdateSnapshot>((resolve) => {
      resolveFlight = resolve;
    });
    const flight: UpdateCheckFlight = { generation: operationGeneration, promise, userInitiated };
    checkFlight = flight;
    settleFlight(runCheck(operationGeneration, flight, previousSnapshot), resolveFlight, 'update check flight failed');
    return promise;
  }

  async function runCheck(
    operationGeneration: number,
    flight: UpdateCheckFlight,
    previousSnapshot: AppUpdateSnapshot
  ): Promise<AppUpdateSnapshot> {
    let shouldDownload = false;
    try {
      const result = await options.executeCheck();
      if (!isCurrent(operationGeneration)) return snapshot;
      const available = Boolean(result?.isUpdateAvailable);
      const version = getUpdateInfoVersion(result?.updateInfo);
      if (available) {
        const downloadedVersion =
          previousSnapshot.status === 'downloaded'
            ? (previousSnapshot.downloadedVersion ?? previousSnapshot.availableVersion)
            : undefined;
        if (downloadedVersion && (!version || compareUpdateVersions(version, downloadedVersion) <= 0)) {
          restoreSnapshotAfterCheck(previousSnapshot, operationGeneration);
        } else {
          commit(
            {
              status: 'available',
              availableVersion: version ?? snapshot.availableVersion,
              checkedAt: now()
            },
            operationGeneration
          );
          shouldDownload = true;
        }
      } else if (previousSnapshot.status === 'downloaded') {
        restoreSnapshotAfterCheck(previousSnapshot, operationGeneration);
      } else {
        commit(
          {
            status: 'not-available',
            availableVersion: version,
            checkedAt: now()
          },
          operationGeneration
        );
      }
    } catch (error) {
      if (isCurrent(operationGeneration)) {
        if (previousSnapshot.status === 'downloaded') {
          const message = formatUpdateError(error);
          if (flight.userInitiated) logFailure('检查更新', message);
          restoreSnapshotAfterCheck(
            previousSnapshot,
            operationGeneration,
            flight.userInitiated
              ? {
                  message: `${updateRefreshFailurePrefix}${message}`,
                  failureKind: 'refresh-check-failed'
                }
              : undefined
          );
        } else if (flight.userInitiated) {
          setFailure(error, '检查更新', operationGeneration);
        } else {
          restoreSnapshotAfterCheck(previousSnapshot, operationGeneration);
        }
      }
    } finally {
      if (activeCheckGeneration === operationGeneration) activeCheckGeneration = undefined;
      activeCheckPublishesEvents = false;
      if (checkFlight?.generation === operationGeneration) checkFlight = undefined;
    }

    if (shouldDownload && isCurrent(operationGeneration)) {
      void download();
    } else {
      schedule();
    }
    return snapshot;
  }

  async function prepareInstall(): Promise<UpdateInstallPreparation> {
    const beforeRefresh = snapshot;
    const downloadedVersion =
      beforeRefresh.status === 'downloaded'
        ? (beforeRefresh.downloadedVersion ?? beforeRefresh.availableVersion)
        : undefined;
    if (!downloadedVersion) {
      return { ready: false, reason: 'not-downloaded', snapshot };
    }

    const refreshed = await check(true);
    if (refreshed.status !== 'downloaded' || refreshed.downloadedVersion !== downloadedVersion) {
      return { ready: false, reason: 'newer-update', snapshot: refreshed };
    }
    if (refreshed.failureKind === 'refresh-check-failed') {
      return { ready: false, reason: 'check-failed', snapshot: refreshed };
    }
    return { ready: true, snapshot: refreshed };
  }

  function download(): Promise<AppUpdateSnapshot> {
    if (disposed || snapshot.status === 'downloaded' || snapshot.status === 'installing') {
      return Promise.resolve(snapshot);
    }
    if (downloadFlight) return downloadFlight.promise;

    clearPeriodicTimer();
    const operationGeneration = ++generation;
    activeDownloadGeneration = operationGeneration;
    commit(
      {
        status: 'downloading',
        percent: snapshot.percent ?? 0,
        downloadPhase: getUpdateDownloadPhase({ percent: snapshot.percent ?? 0 })
      },
      operationGeneration
    );
    let resolveFlight!: (value: AppUpdateSnapshot) => void;
    const promise = new Promise<AppUpdateSnapshot>((resolve) => {
      resolveFlight = resolve;
    });
    downloadFlight = { generation: operationGeneration, promise };
    settleFlight(runDownload(operationGeneration), resolveFlight, 'update download flight failed');
    return promise;
  }

  async function runDownload(operationGeneration: number): Promise<AppUpdateSnapshot> {
    try {
      await options.executeDownload();
      if (isCurrent(operationGeneration) && snapshot.status === 'downloading') {
        commit(
          {
            status: 'downloaded',
            downloadedVersion: snapshot.availableVersion,
            percent: 100,
            checkedAt: now()
          },
          operationGeneration
        );
      }
    } catch (error) {
      if (isCurrent(operationGeneration)) setFailure(error, '更新下载', operationGeneration);
    } finally {
      if (activeDownloadGeneration === operationGeneration) activeDownloadGeneration = undefined;
      if (downloadFlight?.generation === operationGeneration) downloadFlight = undefined;
    }
    schedule();
    return snapshot;
  }

  function setSnapshot(next: Partial<AppUpdateSnapshot>): AppUpdateSnapshot {
    const nextGeneration = ++generation;
    commit(next, nextGeneration);
    if (snapshot.status === 'installing') clearPeriodicTimer();
    return snapshot;
  }

  function commit(next: Partial<AppUpdateSnapshot>, expectedGeneration: number): boolean {
    if (!isCurrent(expectedGeneration)) return false;
    snapshot = normalizeUpdateSnapshot(snapshot, next, options);
    try {
      options.onSnapshot?.(snapshot);
    } catch (error) {
      reportInternalError('update snapshot observer failed', error);
    }
    return true;
  }

  function setFailure(error: unknown, context: string, expectedGeneration: number): void {
    if (!isCurrent(expectedGeneration)) return;
    const message = formatUpdateError(error);
    logFailure(context, message);
    commit({ status: 'failed', checkedAt: now(), message }, expectedGeneration);
  }

  function formatUpdateError(error: unknown): string {
    try {
      return options.formatError(error);
    } catch (formatError) {
      reportInternalError('update error formatter failed', formatError);
      return error instanceof Error ? error.message : String(error);
    }
  }

  function logFailure(context: string, message: string): void {
    if (snapshot.status !== 'failed' || snapshot.message !== message) {
      try {
        options.onLog?.(`${context}失败: ${message}`);
      } catch (logError) {
        reportInternalError('update log observer failed', logError);
      }
    }
  }

  function restoreSnapshotAfterCheck(
    previousSnapshot: AppUpdateSnapshot,
    expectedGeneration: number,
    failure?: Pick<AppUpdateSnapshot, 'message' | 'failureKind'>
  ): void {
    const restored = { ...previousSnapshot, checkedAt: now() };
    delete restored.message;
    delete restored.failureKind;
    if (failure) Object.assign(restored, failure);
    commit(restored, expectedGeneration);
  }

  function settleFlight(
    runner: Promise<AppUpdateSnapshot>,
    resolve: (value: AppUpdateSnapshot) => void,
    context: string
  ): void {
    void runner.then(resolve, (error) => {
      reportInternalError(context, error);
      resolve(snapshot);
    });
  }

  function reportInternalError(context: string, error: unknown): void {
    try {
      console.error(context, error);
    } catch {
      // Observer failures must never break coordinator settlement.
    }
  }

  function schedule(delayMs = options.periodicIntervalMs): void {
    clearPeriodicTimer();
    if (
      !started ||
      disposed ||
      !options.isPackaged() ||
      checkFlight ||
      downloadFlight ||
      snapshot.status === 'installing'
    ) {
      return;
    }

    const timer = setTimer(
      () => {
        if (periodicTimer !== timer) return;
        periodicTimer = undefined;
        timerUnrefed = false;
        try {
          void check(false);
        } catch (error) {
          reportInternalError('scheduled update check failed', error);
        }
      },
      Math.max(0, delayMs)
    );
    periodicTimer = timer;
    timerUnrefed = unrefTimer(timer);
  }

  function pause(): void {
    clearPeriodicTimer();
    generation += 1;
  }

  function dispose(): void {
    if (disposed) return;
    pause();
    disposed = true;
    for (const [event, listener] of listeners) options.updater.removeListener(event, listener);
    activeCheckGeneration = undefined;
    activeDownloadGeneration = undefined;
    checkFlight = undefined;
    downloadFlight = undefined;
  }

  function clearPeriodicTimer(): void {
    if (periodicTimer !== undefined) clearTimer(periodicTimer);
    periodicTimer = undefined;
    timerUnrefed = false;
  }

  function isCurrent(expectedGeneration: number): boolean {
    return !disposed && generation === expectedGeneration;
  }

  function now(): string {
    return options.now?.() ?? new Date().toISOString();
  }

  function inspect(): UpdateCoordinatorInspection {
    return {
      started,
      disposed,
      generation,
      operation: downloadFlight ? 'downloading' : checkFlight ? 'checking' : 'idle',
      status: snapshot.status,
      checkInFlight: Boolean(checkFlight),
      downloadInFlight: Boolean(downloadFlight),
      timerScheduled: periodicTimer !== undefined,
      timerUnrefed
    };
  }

  function createListeners(): Array<[UpdateEventName, UpdateEventListener]> {
    return [
      [
        'checking-for-update',
        () => {
          const eventGeneration = activeCheckGeneration;
          if (eventGeneration === undefined || !activeCheckPublishesEvents) return;
          commit({ status: 'checking', checkedAt: now() }, eventGeneration);
        }
      ],
      [
        'update-available',
        (info) => {
          const eventGeneration = activeCheckGeneration;
          if (eventGeneration === undefined || !activeCheckPublishesEvents) return;
          commit(
            {
              status: 'available',
              availableVersion: getUpdateInfoVersion(info),
              checkedAt: now()
            },
            eventGeneration
          );
        }
      ],
      [
        'download-progress',
        (value) => {
          const eventGeneration = activeDownloadGeneration;
          if (eventGeneration === undefined || !value || typeof value !== 'object') return;
          const progress = value as Record<string, unknown>;
          const percent = normalizeUpdatePercent(progress.percent);
          commit(
            {
              status: 'downloading',
              percent,
              downloadPhase: getUpdateDownloadPhase({
                previousPercent: snapshot.percent,
                previousPhase: snapshot.downloadPhase,
                percent
              }),
              transferredBytes: normalizeUpdateBytes(progress.transferred),
              totalBytes: normalizeUpdateBytes(progress.total),
              bytesPerSecond: normalizeUpdateBytes(progress.bytesPerSecond)
            },
            eventGeneration
          );
        }
      ],
      [
        'update-downloaded',
        (info) => {
          const eventGeneration = activeDownloadGeneration;
          if (eventGeneration === undefined) return;
          const version = getUpdateInfoVersion(info) ?? snapshot.availableVersion;
          commit(
            {
              status: 'downloaded',
              availableVersion: version,
              downloadedVersion: version,
              percent: 100,
              checkedAt: now()
            },
            eventGeneration
          );
        }
      ],
      [
        'update-not-available',
        (info) => {
          const eventGeneration = activeCheckGeneration;
          if (eventGeneration === undefined || !activeCheckPublishesEvents) return;
          commit(
            {
              status: 'not-available',
              availableVersion: getUpdateInfoVersion(info),
              checkedAt: now()
            },
            eventGeneration
          );
        }
      ],
      [
        'error',
        (error) => {
          if (!options.isInstallerLaunchPending?.()) return;
          try {
            options.onInstallerError?.(error);
          } catch (observerError) {
            reportInternalError('update installer error observer failed', observerError);
          }
        }
      ]
    ];
  }

  return {
    start,
    check,
    prepareInstall,
    download,
    schedule,
    pause,
    dispose,
    setSnapshot,
    getSnapshot: () => snapshot,
    inspect
  };
}

export function normalizeUpdateSnapshot(
  current: AppUpdateSnapshot,
  next: Partial<AppUpdateSnapshot>,
  identity: Pick<UpdateCoordinatorOptions, 'currentVersion' | 'buildChannel' | 'updateChannel'>
): AppUpdateSnapshot {
  const merged: AppUpdateSnapshot = {
    ...current,
    ...next,
    currentVersion: identity.currentVersion,
    buildChannel: identity.buildChannel,
    updateChannel: identity.updateChannel
  };

  if (next.status && !Object.prototype.hasOwnProperty.call(next, 'message')) delete merged.message;
  if (next.status && !Object.prototype.hasOwnProperty.call(next, 'failureKind')) delete merged.failureKind;
  if (!['downloading', 'downloaded', 'installing'].includes(merged.status)) delete merged.percent;
  if (merged.status !== 'downloading') {
    delete merged.downloadPhase;
    delete merged.transferredBytes;
    delete merged.totalBytes;
    delete merged.bytesPerSecond;
  } else {
    if (merged.percent === undefined) delete merged.percent;
    if (merged.transferredBytes === undefined) delete merged.transferredBytes;
    if (merged.totalBytes === undefined) delete merged.totalBytes;
    if (merged.bytesPerSecond === undefined) delete merged.bytesPerSecond;
  }
  if (!['available', 'downloading', 'downloaded', 'installing', 'not-available'].includes(merged.status)) {
    delete merged.availableVersion;
  }
  if (merged.status !== 'downloaded' && merged.status !== 'installing') delete merged.downloadedVersion;
  if (merged.status !== 'downloaded' || !merged.message) delete merged.failureKind;
  return merged;
}

function getUpdateInfoVersion(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const version = (info as { version?: unknown }).version;
  return typeof version === 'string' && version.trim() ? version.trim() : undefined;
}

function compareUpdateVersions(left: string, right: string): number {
  const leftVersion = parseUpdateVersion(left);
  const rightVersion = parseUpdateVersion(right);
  if (!leftVersion || !rightVersion) return left.trim() === right.trim() ? 0 : 1;

  for (let index = 0; index < 3; index += 1) {
    const difference = leftVersion.core[index] - rightVersion.core[index];
    if (difference !== 0) return Math.sign(difference);
  }

  if (leftVersion.prerelease.length === 0) return rightVersion.prerelease.length === 0 ? 0 : 1;
  if (rightVersion.prerelease.length === 0) return -1;
  const count = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return Math.sign(leftNumber - rightNumber);
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function parseUpdateVersion(value: string): { core: [number, number, number]; prerelease: string[] } | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined;
  return { core, prerelease: match[4]?.split('.') ?? [] };
}

function normalizeUpdatePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function unrefTimer(timer: TimerHandle): boolean {
  if (!timer || typeof timer !== 'object' || !('unref' in timer)) return false;
  const unref = (timer as { unref?: unknown }).unref;
  if (typeof unref !== 'function') return false;
  unref.call(timer);
  return true;
}
