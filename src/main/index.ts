import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  session as electronSession,
  Tray,
  ipcMain as electronIpcMain,
  safeStorage,
  screen,
  type Rectangle,
  type SaveDialogOptions
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile as writeTextFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { release as getOsRelease } from 'node:os';
import { createLifecycleController, type MihomoRuntime } from './lifecycle';
import { IpcOperationRegistry } from './ipcOperations';
import { connectivityServices, testAllConnectivity, testConnectivity } from './connectivity';
import { createMihomoApiClient } from './mihomo/api';
import { strategyLabels, strategyTargets } from './mihomo/config';
import { createMihomoRuntime } from './mihomo/process';
import { createWindowsDeviceKeyProvider } from './platform/deviceKey';
import { createSystemProxyAdapter } from './platform/systemProxy';
import { runWindowsElevatedProcess, spawnWindowsElevatedMihomo } from './platform/elevatedProcess';
import { createWindowsStartupTask } from './platform/startupTask';
import {
  createFullscreenSuppressionStabilizer,
  getNativeWindowHandleDecimal,
  prepareWindowsFullscreenProbeExecutable,
  startWindowsFullscreenProbe,
  type WindowsFullscreenProbe
} from './platform/windowsFullscreenProbe';
import { SettingsStore } from './storage/settings';
import {
  availabilitySnapshotFromRecord,
  createAvailabilityRecord,
  createEmptyCurrentNodeHealth,
  NodeHealthStore
} from './storage/nodeHealth';
import { resolveDefaultSubscriptionUrl } from './defaultSubscription';
import { resolveAppVersion } from './appVersion';
import { TrafficReporter } from './traffic/reporter';
import { createTemporaryRuntimeLeaseManager, createTrafficRegistrationCoordinator } from './traffic/registration';
import { TrafficStore } from './traffic/store';
import { TrafficTracker } from './traffic/tracker';
import { RemoteConfigClient, type ActiveRemoteConfigSnapshot } from './remoteConfig';
import { createRemoteSubscriptionCoordinator } from './remoteSubscription';
import { calculateMainWindowMetrics } from './windowSizing';
import {
  closeMihomoConnections,
  saveSubscriptionSettings,
  selectMihomoStrategy,
  setMihomoMode,
  testAllMihomoNodes,
  testMihomoNode,
  updateSubscriptionNodes
} from './appActions';
import {
  ipcChannels,
  type AppUpdateSnapshot,
  type AppSnapshot,
  type CurrentNodeHealth,
  type DesktopPetState,
  type DiagnosticIssueKind,
  type OperationRequest,
  type ProxyNode,
  type RemoteControlConfig,
  type StrategyGroup,
  type StrategyKey
} from '../shared/ipc';
import { getUpdateDownloadPhase, normalizeUpdateBytes, updateInstallingMessage } from '../shared/updateProgress';
import { deferUpdateInstallerLaunch } from './updateInstallHandoff';
import { createPetVisibilityController } from './petVisibilityController';
import { applyPetWindowTaskbarPolicy } from './petWindowPolicy';
import { createRuntimeIntentController } from './runtimeIntent';
import { buildProxyRelaunchArguments, resumeProxyAfterRelaunchArgument } from './appRelaunch';
import { clearMihomoRepairCache, runNetworkRepair, type NetworkRepairOptions } from './networkRepair';
import {
  DiagnosticLogBuffer,
  classifyDiagnosticIssue,
  createDiagnosticExportDefaultPath,
  diagnosticSnapshotLogLimit,
  exportDiagnosticReport,
  isDiagnosticIssueResolvedByOperation,
  redactDiagnosticText
} from './diagnostics';
import { getTargetedNetworkRepairActions, runTargetedNetworkRepair } from './targetedNetworkRepair';
import {
  createHostResolverOptions,
  createUpdateFeedConfig,
  prepareUpdateNetworkSession,
  runUpdateCheckWithNetworkFallback,
  runUpdateDownloadWithNetworkFallback
} from './updateNetwork';
import { formatErrorWithCause } from './errorDetails';
import type { FetchLike } from './networkFallback';

declare const __YOUYU_DISABLE_PET__: boolean;
declare const __YOUYU_BUILD_CHANNEL__: string;

const appId = 'studio.youyu.proxy';
const directNetworkPartition = 'youyu-direct-network';
const isDev = !app.isPackaged;
const directNetworkFetch: FetchLike = async (input, init) => {
  const response = await electronSession.fromPartition(directNetworkPartition, { cache: false }).fetch(input, init);
  return response as Response;
};
const startHidden = process.argv.includes('--hidden') || process.argv.includes('--startup');
const shutdownForInstall = process.argv.includes('--shutdown-for-install');
const resumeProxyAfterRelaunch = process.argv.includes(resumeProxyAfterRelaunchArgument);
const windowsStartupTask = createWindowsStartupTask({ executablePath: process.execPath });
let mainWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
const petIpcChannels = new Set<string>([
  ipcChannels.getSnapshot,
  ipcChannels.wavePet,
  ipcChannels.startPetDrag,
  ipcChannels.stopPetDrag,
  ipcChannels.setPetMousePassthrough,
  ipcChannels.showMainWindow
]);
const ipcMain: Pick<typeof electronIpcMain, 'handle'> = {
  handle(channel, listener) {
    return electronIpcMain.handle(channel, (event, ...args) => {
      const trusted = event.sender === mainWindow?.webContents || event.sender === petWindow?.webContents;
      if (!trusted || event.senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(event.senderFrame.url)) {
        throw new Error('untrusted IPC sender');
      }
      if (event.sender === petWindow?.webContents && !petIpcChannels.has(channel)) {
        throw new Error('IPC channel is not available to the pet window');
      }
      return listener(event, ...args);
    });
  }
};
let tray: Tray | null = null;
let trayMenu: Menu | null = null;
let cleanupFinished = false;
let cleanupStarted = false;
let isQuitting = false;
let trayBusy = false;
let petAnimationTimer: ReturnType<typeof setTimeout> | undefined;
let petDragTimer: ReturnType<typeof setInterval> | undefined;
let petDockTimer: ReturnType<typeof setTimeout> | undefined;
let petSequenceTimer: ReturnType<typeof setTimeout> | undefined;
let petMoveTimer: ReturnType<typeof setInterval> | undefined;
let petMousePassthrough = false;
let petFullscreenProbe: WindowsFullscreenProbe | undefined;
let petFullscreenProbeHelperPath: string | undefined;
let petFullscreenProbeGeneration = 0;
let petFullscreenProbeErrorLogged = false;
let petDockBehavior:
  | {
      kind: 'side';
      side: 'edgeLeft' | 'edgeRight';
      startedAt: number;
    }
  | {
      kind: 'top';
      startedAt: number;
    }
  | undefined;
let subscriptionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let remoteConfigSyncTimer: ReturnType<typeof setInterval> | undefined;
let remoteConfigSyncRunning = false;
let updateCheckTimer: ReturnType<typeof setTimeout> | undefined;
let updateCheckRunning = false;
let updateDownloadRunning = false;
let autoUpdatesConfigured = false;
let suppressedUpdateNetworkFailureCount = 0;
let updateInstallerLaunchPending = false;
let updateInstallerLaunchFailed = false;
let updateInstallerLaunchStarted = false;
let updateInstallerBeforeQuitObserved = false;
let updateInstallRuntimeWasRunning = false;
let updateInstallRuntimeIntentGeneration: number | undefined;
let updateInstallAttempt = 0;
let trafficSnapshotBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
let trafficSnapshotBroadcastRunning = false;
let lastTrafficSnapshotBroadcastAt = 0;
let updateSnapshot: AppUpdateSnapshot = {
  currentVersion: '0.0.0',
  buildChannel: 'standard',
  updateChannel: 'latest',
  status: 'idle'
};
let nodeHealthTimer: ReturnType<typeof setTimeout> | undefined;
let nodeHealthCheckOwner: symbol | undefined;
let nodeHealthGeneration = 0;
let currentNodeHealthFailures = 0;
let currentNodeHealthFailureName = '';
let currentNodeHealth = createEmptyCurrentNodeHealth('', connectivityServices.length);
let currentNodeAvailabilityRunning = false;
let currentNodeAvailabilityNode = '';
let runtimeRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let runtimeRecoveryRunning = false;
let runtimeRecoveryFailures = 0;
let networkRepairInProgress = false;
let petDragStart:
  | {
      cursorX: number;
      cursorY: number;
      windowX: number;
      windowY: number;
    }
  | undefined;
let petState: DesktopPetState = 'idle';
let lifecycle: ReturnType<typeof createLifecycleController>;
let runtimePorts = {
  mixedPort: 7890,
  controllerPort: 9090,
  dnsPort: 1053
};
let activeNodeTestController: AbortController | undefined;
let subscriptionRevision = 0;
const ipcOperations = new IpcOperationRegistry((error) => appendLog(`取消操作清理失败: ${formatError(error)}`));
const runtimeIntent = createRuntimeIntentController();
let lastError: string | undefined;
const appLogs = new DiagnosticLogBuffer();
const petFeatureEnabled = !__YOUYU_DISABLE_PET__;
const petVisibilityController = createPetVisibilityController({
  initialUserRequestedVisible: true,
  onVisibilityChange: (visible) => applyPetWindowVisibility(visible)
});
const petFullscreenSuppressionStabilizer = createFullscreenSuppressionStabilizer((suppressed) =>
  petVisibilityController.setFullscreenSuppressed(suppressed)
);
const petWindowSize = {
  width: 190,
  height: 212
};
const petDragFrameMs = 16;
const petSideBlinkDelayMs = 7000;
const petSideSleepDelayMs = 28000;
const petSideDropDelayMs = 65000;
const petTopDropDelayMs = 52000;
const nodeHealthInitialDelayMs = 3000;
const currentNodeDelayRefreshMs = 5 * 60 * 1000;
const nodeHealthIntervalMs = currentNodeDelayRefreshMs;
const nodeHealthRepairDelayMs = 3000;
const nodeHealthRetryDelayMs = 8000;
const nodeHealthFailureThreshold = 2;
const remoteConfigSyncIntervalMs = 3 * 60 * 1000;
const updatePeriodicIntervalMs = 30 * 60 * 1000;
const trafficSnapshotBroadcastIntervalMs = 10000;
const runtimeRecoveryInitialDelayMs = 1500;
const runtimeRecoveryMaxDelayMs = 60000;

function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      return url.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin;
    }
    return url.protocol === 'file:' && url.pathname.endsWith('/renderer/index.html');
  } catch {
    return false;
  }
}

app.setName('YouYu');
if (process.platform === 'win32') {
  app.setAppUserModelId(appId);
}

if (process.env.YOUYU_USER_DATA_DIR) {
  mkdirSync(process.env.YOUYU_USER_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.YOUYU_USER_DATA_DIR);
}

const userDataDir = app.getPath('userData');
const defaultSubscriptionPath = isDev
  ? join(process.cwd(), 'resources/default-subscription.txt')
  : join(process.resourcesPath, 'default-subscription.txt');
const trafficApiUrlPath = isDev
  ? join(process.cwd(), 'resources/traffic-api-url.txt')
  : join(process.resourcesPath, 'traffic-api-url.txt');
const appVersion = resolveAppVersion({
  isPackaged: app.isPackaged,
  packagedVersion: app.getVersion(),
  developmentPackagePath: join(process.cwd(), 'package.json')
});
const appBuildChannel = normalizeBuildChannel(__YOUYU_BUILD_CHANNEL__);
const appUpdateChannel = getUpdateChannelName(appBuildChannel);
updateSnapshot = {
  currentVersion: appVersion,
  buildChannel: appBuildChannel,
  updateChannel: appUpdateChannel,
  status: 'idle'
};
const settingsStore = new SettingsStore(app.getPath('userData'), {
  defaultSubscriptionUrl: readDefaultSubscriptionUrl(defaultSubscriptionPath)
});
const trafficStore = new TrafficStore(app.getPath('userData'), { secretStorage: safeStorage });
const deviceKeyProvider = createWindowsDeviceKeyProvider();
const nodeHealthStore = new NodeHealthStore(app.getPath('userData'));
const remoteConfigClient = new RemoteConfigClient({
  baseDir: app.getPath('userData'),
  endpoint: readOptionalText(trafficApiUrlPath),
  appVersion,
  store: trafficStore,
  fetch: directNetworkFetch
});
const remoteSubscriptionCoordinator = createRemoteSubscriptionCoordinator({
  readSettings: () => settingsStore.read(),
  updateRemoteSubscription: (value) => settingsStore.update({ remoteSubscriptionUrl: value }),
  isSnapshotCurrent: (snapshot) => remoteConfigClient.isActiveConfigSnapshotCurrent(snapshot),
  getActiveSnapshot: () => remoteConfigClient.getActiveConfigSnapshot(),
  onChanged: (url) => {
    appendLog(url ? '远程订阅已更新' : '远程订阅已清除');
    scheduleSubscriptionRefresh();
  }
});
const trafficReporter = new TrafficReporter({
  store: trafficStore,
  endpoint: readOptionalText(trafficApiUrlPath),
  appVersion,
  intervalMs: 2 * 60 * 1000,
  fetch: directNetworkFetch,
  getDeviceKey: () => deviceKeyProvider.getDeviceKey(),
  getProxyUrl: getRuntimeTrafficProxyUrl,
  onIdentityInvalidated: handleTrafficIdentityInvalidated,
  onError: (error) => {
    if (!isRecoverableSyncError(error)) {
      appendLog(`流量上报失败: ${formatError(error)}`);
    }
  }
});
const trafficTracker = new TrafficTracker({
  store: trafficStore,
  intervalMs: 5000,
  isRunning: () => lifecycle.getStatus() === 'running',
  readRuntimeStats: async () => {
    const settings = await settingsStore.read();
    return createRuntimeMihomoApi({ secret: settings.controllerSecret }).getRuntimeStats({
      includeConnections: true
    });
  },
  readCurrentNode: async () => {
    const settings = await settingsStore.read();
    return createRuntimeMihomoApi({ secret: settings.controllerSecret }).getCurrentNode();
  },
  onSample: scheduleTrafficSnapshotBroadcast,
  onError: (error) => appendLog(`流量统计失败: ${formatError(error)}`)
});
const mihomoBinaryPath = isDev
  ? join(process.cwd(), 'resources/mihomo/win-x64/mihomo.exe')
  : join(process.resourcesPath, 'mihomo/win-x64/mihomo.exe');
const windowIconPath = isDev ? join(process.cwd(), 'build/icon.png') : join(process.resourcesPath, 'assets/icon.png');
const trayIconPath = isDev
  ? join(process.cwd(), 'build/tray-icon.png')
  : join(process.resourcesPath, 'assets/tray-icon.png');
const mihomoRuntime: MihomoRuntime =
  process.platform === 'win32'
    ? createMihomoRuntime({
        binaryPath: mihomoBinaryPath,
        userDataDir,
        readSettings: () => settingsStore.read(),
        readRemoteConfig: () => remoteConfigClient.getActiveConfig(),
        readRemoteConfigSnapshot: () => remoteConfigClient.getActiveConfigSnapshot(),
        isRemoteConfigSnapshotCurrent: (snapshot) => remoteConfigClient.isActiveConfigSnapshotCurrent(snapshot),
        getPorts: allocateRuntimePorts,
        spawnElevatedProcess: (binaryPath, args) => spawnWindowsElevatedMihomo(binaryPath, args),
        logLine: appendLog,
        onUnexpectedExit: (reason) => {
          recordError('mihomo 异常退出', reason);
          lifecycle.markRuntimeExited?.(reason);
          scheduleRuntimeRecovery(runtimeRecoveryInitialDelayMs);
          refreshTrayMenu();
          void broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
        }
      })
    : {
        async start() {
          return undefined;
        },
        async stop() {
          return undefined;
        },
        isRunning() {
          return false;
        }
      };

function readDefaultSubscriptionUrl(path: string): string {
  return resolveDefaultSubscriptionUrl(readOptionalText(path));
}

function readOptionalText(path: string): string {
  if (!existsSync(path)) return '';

  return readFileSync(path, 'utf8').trim();
}

function appendLog(message: string) {
  appLogs.append(message);
}

function formatError(error: unknown): string {
  return formatErrorWithCause(error);
}

function recordError(context: string, error: unknown) {
  lastError = redactDiagnosticText(`${context}: ${formatError(error)}`);
  appendLog(lastError);
}

async function exportCurrentDiagnostics() {
  const settings = await settingsStore.read().catch(() => undefined);
  const exportedAt = new Date();
  const logs = appLogs.getLogs();

  return exportDiagnosticReport(
    {
      exportedAt,
      appVersion,
      buildChannel: appBuildChannel,
      status: lifecycle.getStatus(),
      platform: process.platform,
      architecture: process.arch,
      osRelease: getOsRelease(),
      features: settings
        ? {
            systemProxyEnabled: settings.systemProxyEnabled,
            dnsEnhanced: settings.dnsEnhanced,
            snifferEnabled: settings.snifferEnabled,
            tunEnabled: settings.tunEnabled
          }
        : undefined,
      runtimePorts: { ...runtimePorts },
      logCapacity: appLogs.capacity,
      droppedLogCount: appLogs.droppedCount,
      lastError,
      logs
    },
    {
      chooseFile: async (defaultFileName) => {
        const options: SaveDialogOptions = {
          title: '导出诊断日志',
          defaultPath: createDiagnosticExportDefaultPath(app.getPath('downloads'), defaultFileName),
          filters: [{ name: '文本文件', extensions: ['txt'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent']
        };
        const result =
          mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showSaveDialog(mainWindow, options)
            : await dialog.showSaveDialog(options);
        return result.canceled ? undefined : result.filePath;
      },
      writeFile: (filePath, contents) => writeTextFile(filePath, contents, 'utf8')
    }
  );
}

function normalizeBuildChannel(channel: string | undefined): AppUpdateSnapshot['buildChannel'] {
  if (channel === 'in' || channel === 'no') return channel;
  return 'standard';
}

function getUpdateChannelName(channel: AppUpdateSnapshot['buildChannel']): string {
  if (channel === 'in') return 'latest-in';
  if (channel === 'no') return 'latest-no';
  return 'latest';
}

function getRuntimeTrafficProxyUrl(): string | undefined {
  return lifecycle?.getStatus() === 'running' ? `http://127.0.0.1:${runtimePorts.mixedPort}` : undefined;
}

function scheduleTrafficSnapshotBroadcast() {
  if (trafficSnapshotBroadcastTimer) return;
  const elapsedMs = Date.now() - lastTrafficSnapshotBroadcastAt;
  const delayMs = Math.max(0, trafficSnapshotBroadcastIntervalMs - elapsedMs);
  trafficSnapshotBroadcastTimer = setTimeout(() => {
    trafficSnapshotBroadcastTimer = undefined;
    if (trafficSnapshotBroadcastRunning) {
      scheduleTrafficSnapshotBroadcast();
      return;
    }
    trafficSnapshotBroadcastRunning = true;
    void broadcastSnapshot()
      .then(() => {
        lastTrafficSnapshotBroadcastAt = Date.now();
      })
      .catch((error) => console.error('broadcast snapshot failed', error))
      .finally(() => {
        trafficSnapshotBroadcastRunning = false;
      });
  }, delayMs);
}

async function syncRemoteConfig(
  options: {
    proxyUrl?: string;
    restartIfRunning?: boolean;
    throwOnError?: boolean;
    quiet?: boolean;
    signal?: AbortSignal;
    intentGeneration?: number;
  } = {}
): Promise<boolean> {
  let subscriptionChanged = false;
  let restartAttempted = false;
  const restartIfNeeded = async () => {
    if (
      options.restartIfRunning &&
      !networkRepairInProgress &&
      lifecycle.getStatus() === 'running' &&
      options.intentGeneration !== undefined &&
      runtimeIntent.isCurrent(options.intentGeneration)
    ) {
      restartAttempted = true;
      await restartLifecycleForIntent(options.intentGeneration, options.signal);
    }
  };

  try {
    throwIfAborted(options.signal);
    const cachedSnapshot = await remoteConfigClient.getActiveConfigSnapshot();
    subscriptionChanged = await applyRemoteSubscription(cachedSnapshot.config, cachedSnapshot);
    throwIfAborted(options.signal);
    const result = await remoteConfigClient.sync({ proxyUrl: options.proxyUrl, signal: options.signal });
    throwIfAborted(options.signal);
    const syncedSnapshot = await remoteConfigClient.getActiveConfigSnapshot();
    subscriptionChanged = (await applyRemoteSubscription(syncedSnapshot.config, syncedSnapshot)) || subscriptionChanged;
    throwIfAborted(options.signal);
    if (!result.changed && !subscriptionChanged) return false;

    appendLog(`remote config updated: v${syncedSnapshot.config?.version ?? 0}`);
    await restartIfNeeded();
    return true;
  } catch (error) {
    let reportedError = error;
    if (subscriptionChanged && !restartAttempted) {
      try {
        await restartIfNeeded();
      } catch (restartError) {
        reportedError = new AggregateError(
          [error, restartError],
          'remote config sync failed after subscription reconciliation',
          { cause: error }
        );
      }
    }
    const recoverable = isRecoverableSyncError(reportedError);
    if (!recoverable || (!options.quiet && options.throwOnError)) {
      appendLog(`remote config sync failed: ${formatError(reportedError)}`);
    }
    if (options.throwOnError) throw reportedError;
    return subscriptionChanged;
  }
}

function startRemoteConfigPolling() {
  if (remoteConfigSyncTimer) return;
  remoteConfigSyncTimer = setInterval(() => {
    void syncRemoteConfigInBackground();
  }, remoteConfigSyncIntervalMs);
  void syncRemoteConfigInBackground();
}

function stopRemoteConfigPolling() {
  if (!remoteConfigSyncTimer) return;
  clearInterval(remoteConfigSyncTimer);
  remoteConfigSyncTimer = undefined;
}

async function syncRemoteConfigInBackground(): Promise<void> {
  if (remoteConfigSyncRunning || networkRepairInProgress || cleanupStarted || cleanupFinished || isQuitting) return;
  const intentGeneration = runtimeIntent.capture();
  remoteConfigSyncRunning = true;
  try {
    await syncRemoteConfig({
      proxyUrl: getRuntimeTrafficProxyUrl(),
      restartIfRunning: true,
      quiet: true,
      intentGeneration
    });
  } finally {
    remoteConfigSyncRunning = false;
  }
}

async function applyRemoteSubscription(
  config?: RemoteControlConfig,
  snapshot?: ActiveRemoteConfigSnapshot
): Promise<boolean> {
  return remoteSubscriptionCoordinator.apply(config, snapshot);
}

function isRecoverableSyncError(error: unknown): boolean {
  const message = formatError(error);
  return [
    'fetch failed',
    'Failed to fetch',
    'request timed out',
    'proxy connect timed out',
    'aborted',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN'
  ].some((needle) => message.includes(needle));
}

function clearLastError() {
  lastError = undefined;
}

function clearLastErrorIfUnchanged(expected: string | undefined): boolean {
  if (lastError !== expected) return false;
  clearLastError();
  return true;
}

function setupAutoUpdates() {
  if (autoUpdatesConfigured) return;
  autoUpdatesConfigured = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL(createUpdateFeedConfig());
  autoUpdater.channel = appUpdateChannel;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    setUpdateSnapshot({
      status: 'checking',
      checkedAt: new Date().toISOString()
    });
  });
  autoUpdater.on('update-available', (info) => {
    setUpdateSnapshot({
      status: 'available',
      availableVersion: getUpdateInfoVersion(info),
      checkedAt: new Date().toISOString()
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    const percent = normalizeUpdatePercent(progress.percent);
    const downloadPhase = getUpdateDownloadPhase({
      previousPercent: updateSnapshot.percent,
      previousPhase: updateSnapshot.downloadPhase,
      percent
    });
    setUpdateSnapshot({
      status: 'downloading',
      percent,
      downloadPhase,
      transferredBytes: normalizeUpdateBytes(progress.transferred),
      totalBytes: normalizeUpdateBytes(progress.total),
      bytesPerSecond: normalizeUpdateBytes(progress.bytesPerSecond)
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateSnapshot({
      status: 'downloaded',
      availableVersion: getUpdateInfoVersion(info),
      downloadedVersion: getUpdateInfoVersion(info),
      percent: 100,
      checkedAt: new Date().toISOString()
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    setUpdateSnapshot({
      status: 'not-available',
      availableVersion: getUpdateInfoVersion(info),
      checkedAt: new Date().toISOString()
    });
  });
  autoUpdater.on('error', (error) => {
    if (updateInstallerLaunchPending) {
      recoverFromUpdateInstallerLaunchFailure(error);
      return;
    }
    if (suppressedUpdateNetworkFailureCount > 0) return;
    setUpdateFailure(error);
  });

  void checkForUpdatesNow(false).catch((error) => {
    appendLog(`检查更新失败: ${formatError(error)}`);
  });
}

function setUpdateSnapshot(next: Partial<AppUpdateSnapshot>) {
  const merged: AppUpdateSnapshot = {
    ...updateSnapshot,
    ...next,
    currentVersion: appVersion,
    buildChannel: appBuildChannel,
    updateChannel: appUpdateChannel
  };

  if (next.status && !Object.prototype.hasOwnProperty.call(next, 'message')) {
    delete merged.message;
  }
  if (merged.status !== 'downloading' && merged.status !== 'downloaded') {
    delete merged.percent;
  }
  if (merged.status !== 'downloading') {
    delete merged.downloadPhase;
    delete merged.transferredBytes;
    delete merged.totalBytes;
    delete merged.bytesPerSecond;
  }
  if (!['available', 'downloading', 'downloaded', 'not-available'].includes(merged.status)) {
    delete merged.availableVersion;
  }
  if (merged.status !== 'downloaded') {
    delete merged.downloadedVersion;
  }

  updateSnapshot = merged;
  void broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
}

function scheduleUpdateCheck(delayMs = updatePeriodicIntervalMs) {
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = undefined;
  }
  if (!app.isPackaged || updateSnapshot.status === 'downloaded') return;

  updateCheckTimer = setTimeout(() => {
    updateCheckTimer = undefined;
    void checkForUpdatesNow(false).catch((error) => {
      appendLog(`检查更新失败: ${formatError(error)}`);
    });
  }, delayMs);
}

async function checkForUpdatesNow(userInitiated = true): Promise<AppSnapshot> {
  if (!app.isPackaged) {
    setUpdateSnapshot({
      status: 'not-available',
      checkedAt: new Date().toISOString(),
      message: userInitiated ? '开发环境不检查更新' : undefined
    });
    return createSnapshot();
  }

  if (updateSnapshot.status === 'downloaded' || updateCheckRunning || updateDownloadRunning) {
    return createSnapshot();
  }

  updateCheckRunning = true;
  suppressedUpdateNetworkFailureCount += 1;
  let checkResult: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>> | undefined;
  let checkFailure: unknown;
  let checkFailed = false;
  try {
    checkResult = await runUpdateCheckWithNetworkFallback({
      session: autoUpdater.netSession,
      check: () => autoUpdater.checkForUpdates(),
      proxyUrl: getRuntimeTrafficProxyUrl(),
      onRetry: (route, detail) => {
        appendLog(
          route === 'local-proxy'
            ? `检查更新直连失败，改用本地代理重试 (${detail})`
            : `检查更新直连失败，刷新 DNS 后重试 (${detail})`
        );
      }
    });
  } catch (error) {
    checkFailure = error;
    checkFailed = true;
  } finally {
    suppressedUpdateNetworkFailureCount = Math.max(0, suppressedUpdateNetworkFailureCount - 1);
    updateCheckRunning = false;
    scheduleUpdateCheck(updatePeriodicIntervalMs);
  }

  if (checkFailed) {
    setUpdateFailure(checkFailure);
  } else if (checkResult?.isUpdateAvailable) {
    void downloadUpdateInBackground();
  }

  return createSnapshot();
}

async function downloadUpdateInBackground(): Promise<void> {
  if (updateDownloadRunning || updateSnapshot.status === 'downloaded') return;

  updateDownloadRunning = true;
  suppressedUpdateNetworkFailureCount += 1;
  let downloadFailure: unknown;
  let downloadFailed = false;
  try {
    await runUpdateDownloadWithNetworkFallback({
      session: autoUpdater.netSession,
      download: () => autoUpdater.downloadUpdate(),
      proxyUrl: getRuntimeTrafficProxyUrl(),
      onRetry: (route, detail) => {
        appendLog(
          route === 'local-proxy'
            ? `更新下载直连失败，改用本地代理重试 (${detail})`
            : `更新下载直连失败，刷新 DNS 后重试 (${detail})`
        );
      }
    });
  } catch (error) {
    downloadFailure = error;
    downloadFailed = true;
  } finally {
    suppressedUpdateNetworkFailureCount = Math.max(0, suppressedUpdateNetworkFailureCount - 1);
    updateDownloadRunning = false;
  }

  if (downloadFailed) {
    setUpdateFailure(downloadFailure, '更新下载');
  }
}

function setUpdateFailure(error: unknown, context = '检查更新') {
  const message = formatError(error);
  if (updateSnapshot.status !== 'failed' || updateSnapshot.message !== message) {
    appendLog(`${context}失败: ${message}`);
  }
  setUpdateSnapshot({
    status: 'failed',
    checkedAt: new Date().toISOString(),
    message
  });
}

async function installDownloadedUpdate(): Promise<AppSnapshot> {
  if (updateSnapshot.status !== 'downloaded' || updateInstallerLaunchPending) {
    throw new Error('update not downloaded');
  }

  updateInstallerLaunchPending = true;
  updateInstallerLaunchFailed = false;
  updateInstallerLaunchStarted = false;
  updateInstallerBeforeQuitObserved = false;
  updateInstallRuntimeWasRunning = lifecycle.getStatus() === 'running';
  updateInstallRuntimeIntentGeneration = runtimeIntent.capture();
  const installAttempt = ++updateInstallAttempt;
  lifecycle.suspendStarts();
  setUpdateSnapshot({ status: 'installing', message: updateInstallingMessage });
  try {
    await prepareForUpdateInstall();
    if (installAttempt !== updateInstallAttempt || !updateInstallerLaunchPending) {
      throw new Error('update install preparation canceled');
    }
    const snapshot = await createSnapshot();
    refreshTrayMenu();
    deferUpdateInstallerLaunch({
      launch: () => {
        if (!updateInstallerLaunchPending || updateInstallAttempt !== installAttempt) {
          return;
        }
        updateInstallerLaunchStarted = true;
        cleanupFinished = true;
        isQuitting = true;
        autoUpdater.quitAndInstall(true, true);
      },
      onError: recoverFromUpdateInstallerLaunchFailure
    });
    return snapshot;
  } catch (error) {
    if (installAttempt === updateInstallAttempt && updateInstallerLaunchPending) {
      recoverFromUpdateInstallFailure('准备安装失败', error);
    }
    throw error;
  }
}

function recoverFromUpdateInstallerLaunchFailure(error: unknown) {
  recoverFromUpdateInstallFailure('启动安装器失败', error);
}

function recoverFromUpdateInstallFailure(prefix: string, error: unknown) {
  if (!updateInstallerLaunchPending) return;
  const message = `${prefix}: ${formatError(error)}`;
  const beforeQuitWasObserved = updateInstallerBeforeQuitObserved;
  const restartIntentGeneration = updateInstallRuntimeIntentGeneration;
  const shouldRestartRuntime =
    updateInstallRuntimeWasRunning &&
    restartIntentGeneration !== undefined &&
    runtimeIntent.isCurrent(restartIntentGeneration);
  updateInstallerLaunchPending = false;
  updateInstallAttempt += 1;
  updateInstallerLaunchFailed = beforeQuitWasObserved;
  updateInstallerLaunchStarted = false;
  updateInstallerBeforeQuitObserved = false;
  updateInstallRuntimeWasRunning = false;
  updateInstallRuntimeIntentGeneration = undefined;
  cleanupFinished = false;
  isQuitting = false;
  lifecycle.resumeStarts();
  restartPetFullscreenProbe();
  appendLog(message);
  setUpdateSnapshot({ status: 'downloaded', message });
  refreshTrayMenu();
  startRemoteConfigPolling();
  if (shouldRestartRuntime && restartIntentGeneration !== undefined) {
    void startLifecycleWithRepairRetry(undefined, restartIntentGeneration)
      .then(() => {
        trafficTracker.start();
        trafficReporter.start();
        scheduleNodeHealthCheck(0);
      })
      .catch((restartError) => recordError('安装取消后的代理恢复失败', restartError));
  }
}

function isUpdateInstallerHandoffPending(): boolean {
  return updateInstallerLaunchPending && !updateInstallerLaunchStarted;
}

async function prepareForUpdateInstall(): Promise<void> {
  await trafficTracker.flush().catch((error) => appendLog(`流量统计失败: ${formatError(error)}`));
  await trafficReporter.reportPending().catch((error) => appendLog(`流量上报失败: ${formatError(error)}`));
  trafficTracker.stop();
  trafficReporter.stop();
  if (lifecycle.getStatus() !== 'stopped') {
    await lifecycle.stop();
  }
  if (petFeatureEnabled) {
    stopPetFullscreenProbe({ restoreVisibility: false });
  }
}

function getUpdateInfoVersion(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const version = (info as { version?: unknown }).version;
  return typeof version === 'string' && version.trim() ? version.trim() : undefined;
}

function normalizeUpdatePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

async function listenOnPort(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

async function closeServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function canListen(port: number): Promise<boolean> {
  try {
    const server = await listenOnPort(port);
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

async function getRandomPort(): Promise<number> {
  const server = await listenOnPort(0);
  const address = server.address();
  await closeServer(server);
  return typeof address === 'object' && address ? address.port : 0;
}

async function findAvailablePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 80; port += 1) {
    if (await canListen(port)) return port;
  }
  return getRandomPort();
}

async function allocateRuntimePorts() {
  const mixedPort = await findAvailablePort(7890);
  const controllerPort = await getRandomPort();
  const dnsPort = await getRandomPort();
  runtimePorts = { mixedPort, controllerPort, dnsPort };
  appendLog(`runtime ports: mixed=${mixedPort}, controller=${controllerPort}, dns=${dnsPort}`);
  return runtimePorts;
}

const systemProxy = createSystemProxyAdapter({
  stateDirectory: app.getPath('userData'),
  runElevatedCommand: (command, signal) => runWindowsElevatedProcess(command.file, command.args, { signal }),
  shouldManageProxy: async () => {
    const settings = await settingsStore.read();
    return settings.systemProxyEnabled;
  },
  getProxyServer: () => `127.0.0.1:${runtimePorts.mixedPort}`
});

lifecycle = createLifecycleController({
  proxy: systemProxy,
  mihomo: mihomoRuntime,
  onStatusChange: (status) => {
    if (status === 'running') {
      trafficTracker.start();
      trafficReporter.start();
      clearRuntimeRecoveryTimer();
      runtimeRecoveryFailures = 0;
      startNodeHealthMonitor();
    } else {
      trafficTracker.stop();
      trafficReporter.stop();
      stopNodeHealthMonitor();
    }
    if (status === 'failed') {
      scheduleRuntimeRecovery(runtimeRecoveryInitialDelayMs);
    }
    if (status === 'stopped') {
      clearRuntimeRecoveryTimer();
    }
    refreshTrayMenu();
    syncPetStateToRuntime();
    scheduleSubscriptionRefresh();
  }
});

const temporaryRegistrationRuntime = createTemporaryRuntimeLeaseManager({
  isRuntimeRunning: () => lifecycle.getStatus() === 'running',
  captureRuntimeIntent: () => runtimeIntent.capture(),
  startRuntime: (intentGeneration) => startLifecycleWithRepairRetry(undefined, intentGeneration),
  stopRuntime: () => lifecycle.stop(),
  log: appendLog
});

const trafficRegistration = createTrafficRegistrationCoordinator({
  reporter: trafficReporter,
  store: trafficStore,
  hasSubscription: async () => Boolean((await settingsStore.read()).subscriptionUrl.trim()),
  acquireTemporaryRuntime: temporaryRegistrationRuntime.acquire,
  stopRuntime: () => lifecycle.stop(),
  getProxyUrl: getRuntimeTrafficProxyUrl,
  formatError,
  log: appendLog
});

const userRuntimeActions = {
  start: startLifecycleForUser,
  restart: restartLifecycleForUser
};

function clearSubscriptionRefreshTimer() {
  if (subscriptionRefreshTimer) {
    clearTimeout(subscriptionRefreshTimer);
    subscriptionRefreshTimer = undefined;
  }
}

function scheduleSubscriptionRefresh() {
  clearSubscriptionRefreshTimer();
  if (networkRepairInProgress || lifecycle.getStatus() !== 'running') return;

  void settingsStore
    .read()
    .then((settings) => {
      const intervalHours = settings.subscriptionRefreshIntervalHours;
      if (!settings.subscriptionUrl.trim() || intervalHours <= 0 || lifecycle.getStatus() !== 'running') {
        return;
      }

      subscriptionRefreshTimer = setTimeout(
        () => {
          void refreshSubscriptionInBackground();
        },
        intervalHours * 60 * 60 * 1000
      );
    })
    .catch((error) => {
      recordError('订阅刷新计划失败', error);
    });
}

async function refreshSubscriptionInBackground() {
  if (networkRepairInProgress) return;
  if (lifecycle.getStatus() !== 'running') {
    scheduleSubscriptionRefresh();
    return;
  }
  const intentGeneration = runtimeIntent.capture();
  if (intentGeneration === undefined) {
    scheduleSubscriptionRefresh();
    return;
  }

  const lastErrorBeforeRefresh = lastError;
  const issueBeforeRefresh = classifyDiagnosticIssue(lastErrorBeforeRefresh);
  try {
    appendLog('后台刷新订阅');
    await updateSubscriptionNodes({
      settingsStore,
      lifecycle,
      runtime: runtimeActionsForIntent(intentGeneration),
      createMihomoApi: createRuntimeMihomoApi,
      createSnapshot
    });
    subscriptionRevision += 1;
    if (isDiagnosticIssueResolvedByOperation('subscription-refresh', issueBeforeRefresh)) {
      clearLastErrorIfUnchanged(lastErrorBeforeRefresh);
    }
    sendSnapshotToWindows(await createSnapshot());
  } catch (error) {
    recordError('后台刷新订阅失败', error);
    await broadcastSnapshot().catch((broadcastError) => console.error('broadcast snapshot failed', broadcastError));
  } finally {
    refreshTrayMenu();
    scheduleSubscriptionRefresh();
  }
}

function startNodeHealthMonitor() {
  nodeHealthGeneration += 1;
  scheduleNodeHealthCheck(nodeHealthInitialDelayMs);
}

function stopNodeHealthMonitor() {
  nodeHealthGeneration += 1;
  if (nodeHealthTimer) {
    clearTimeout(nodeHealthTimer);
    nodeHealthTimer = undefined;
  }
  if (currentNodeHealth.delayStatus === 'testing') {
    updateCurrentNodeDelay(currentNodeHealth.nodeName, {
      delayStatus: 'untested',
      delay: undefined,
      delayCheckedAt: undefined
    });
  }
}

function syncCurrentNodeHealthName(nodeName: string) {
  if (currentNodeHealth.nodeName === nodeName) return;

  currentNodeHealth = createEmptyCurrentNodeHealth(nodeName, connectivityServices.length);
}

function isProxyNodeName(nodeName: string): boolean {
  return Boolean(nodeName) && nodeName !== 'DIRECT';
}

function shouldRefreshCurrentNodeDelay(nodeName: string): boolean {
  syncCurrentNodeHealthName(nodeName);
  if (currentNodeHealth.delayStatus === 'testing') return false;

  const checkedAt = currentNodeHealth.delayCheckedAt ? Date.parse(currentNodeHealth.delayCheckedAt) : 0;
  return !checkedAt || Date.now() - checkedAt >= currentNodeDelayRefreshMs;
}

function updateCurrentNodeDelay(
  nodeName: string,
  next: Pick<CurrentNodeHealth, 'delayStatus' | 'delay' | 'delayCheckedAt'>
) {
  syncCurrentNodeHealthName(nodeName);
  currentNodeHealth = {
    ...currentNodeHealth,
    ...next
  };
}

async function updateCurrentNodeDelayFromManualTest(
  nodeName: string,
  delay: number | undefined,
  testState?: ProxyNode['testState']
): Promise<void> {
  if (!isProxyNodeName(nodeName) || lifecycle.getStatus() !== 'running') return;
  const settings = await settingsStore.read();
  const currentNode = await createRuntimeMihomoApi({ secret: settings.controllerSecret })
    .getCurrentNode()
    .catch(() => '');
  if (currentNode !== nodeName) return;

  if (testState === 'testing') {
    updateCurrentNodeDelay(nodeName, {
      delayStatus: 'testing',
      delay: undefined,
      delayCheckedAt: undefined
    });
    return;
  }

  updateCurrentNodeDelay(nodeName, {
    delayStatus: typeof delay === 'number' ? 'measured' : 'failed',
    delay,
    delayCheckedAt: new Date().toISOString()
  });
}

function updateCurrentNodeAvailabilityStatus(nodeName: string, status: CurrentNodeHealth['availability']['status']) {
  syncCurrentNodeHealthName(nodeName);
  currentNodeHealth = {
    ...currentNodeHealth,
    availability: {
      status,
      totalCount: connectivityServices.length
    }
  };
}

async function getCurrentNodeHealthSnapshot(nodeName: string, running: boolean): Promise<CurrentNodeHealth> {
  syncCurrentNodeHealthName(nodeName);

  if (!running || !isProxyNodeName(nodeName)) {
    currentNodeHealth = createEmptyCurrentNodeHealth(nodeName, connectivityServices.length);
    return currentNodeHealth;
  }

  const record = await nodeHealthStore.getTodayAvailability(nodeName).catch((error) => {
    appendLog(`读取节点可用度失败: ${formatError(error)}`);
    return undefined;
  });
  if (record) {
    currentNodeHealth = {
      ...currentNodeHealth,
      availability: availabilitySnapshotFromRecord(record)
    };
    return currentNodeHealth;
  }

  if (currentNodeHealth.availability.status === 'measured' && !isLocalToday(currentNodeHealth.availability.checkedAt)) {
    currentNodeHealth = {
      ...currentNodeHealth,
      availability: {
        status: 'untested',
        totalCount: connectivityServices.length
      }
    };
  }

  return currentNodeHealth;
}

async function maybeStartCurrentNodeAvailabilityCheck(nodeName: string) {
  if (!isProxyNodeName(nodeName) || lifecycle.getStatus() !== 'running') return;
  if (currentNodeAvailabilityRunning) return;

  const cached = await nodeHealthStore.getTodayAvailability(nodeName).catch((error) => {
    appendLog(`读取节点可用度失败: ${formatError(error)}`);
    return undefined;
  });
  if (cached) {
    syncCurrentNodeHealthName(nodeName);
    currentNodeHealth = {
      ...currentNodeHealth,
      availability: availabilitySnapshotFromRecord(cached)
    };
    return;
  }

  currentNodeAvailabilityRunning = true;
  currentNodeAvailabilityNode = nodeName;
  updateCurrentNodeAvailabilityStatus(nodeName, 'testing');
  void broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));

  try {
    const results = await testAllConnectivity({
      getMixedPort: () => runtimePorts.mixedPort,
      getControllerPort: () => runtimePorts.controllerPort,
      getControllerSecret: async () => (await settingsStore.read()).controllerSecret,
      isRunning: () => lifecycle.getStatus() === 'running'
    });
    if (!(await isStillCurrentNode(nodeName))) {
      return;
    }

    const record = createAvailabilityRecord(nodeName, results);
    await nodeHealthStore.saveAvailability(record);

    if (currentNodeHealth.nodeName === nodeName) {
      currentNodeHealth = {
        ...currentNodeHealth,
        availability: availabilitySnapshotFromRecord(record)
      };
      void broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
    }
  } catch (error) {
    appendLog(`节点可用度测试失败: ${formatError(error)}`);
    if (currentNodeHealth.nodeName === nodeName) {
      updateCurrentNodeAvailabilityStatus(nodeName, 'failed');
      void broadcastSnapshot().catch((broadcastError) => console.error('broadcast snapshot failed', broadcastError));
    }
  } finally {
    if (currentNodeAvailabilityNode === nodeName) {
      currentNodeAvailabilityNode = '';
    }
    currentNodeAvailabilityRunning = false;
  }
}

async function isStillCurrentNode(nodeName: string): Promise<boolean> {
  if (lifecycle.getStatus() !== 'running') return false;
  try {
    const settings = await settingsStore.read();
    const currentNode = await createRuntimeMihomoApi({ secret: settings.controllerSecret }).getCurrentNode();
    return currentNode === nodeName;
  } catch {
    return false;
  }
}

function isLocalToday(isoDate?: string): boolean {
  if (!isoDate) return false;
  const checkedAt = new Date(isoDate);
  if (!Number.isFinite(checkedAt.getTime())) return false;
  const now = new Date();
  return (
    checkedAt.getFullYear() === now.getFullYear() &&
    checkedAt.getMonth() === now.getMonth() &&
    checkedAt.getDate() === now.getDate()
  );
}

function scheduleNodeHealthCheck(delayMs = nodeHealthIntervalMs) {
  if (nodeHealthTimer) {
    clearTimeout(nodeHealthTimer);
    nodeHealthTimer = undefined;
  }
  if (lifecycle.getStatus() !== 'running') return;

  nodeHealthTimer = setTimeout(() => {
    nodeHealthTimer = undefined;
    void runNodeHealthCheck();
  }, delayMs);
}

function clearRuntimeRecoveryTimer() {
  if (runtimeRecoveryTimer) {
    clearTimeout(runtimeRecoveryTimer);
    runtimeRecoveryTimer = undefined;
  }
}

function getRuntimeRecoveryDelay(): number {
  return Math.min(runtimeRecoveryMaxDelayMs, runtimeRecoveryInitialDelayMs * 2 ** runtimeRecoveryFailures);
}

function scheduleRuntimeRecovery(delayMs = getRuntimeRecoveryDelay()) {
  if (networkRepairInProgress || isQuitting || cleanupStarted || cleanupFinished) return;
  if (runtimeIntent.capture() === undefined) return;
  if (lifecycle.getStatus() === 'stopped') return;

  clearRuntimeRecoveryTimer();
  runtimeRecoveryTimer = setTimeout(() => {
    runtimeRecoveryTimer = undefined;
    void runRuntimeRecovery();
  }, delayMs);
}

async function runRuntimeRecovery() {
  const intentGeneration = runtimeIntent.capture();
  if (intentGeneration === undefined) return;
  if (runtimeRecoveryRunning || networkRepairInProgress || isQuitting || cleanupStarted || cleanupFinished) return;
  if (lifecycle.getStatus() === 'stopped') return;

  runtimeRecoveryRunning = true;
  try {
    appendLog('检测到代理异常，正在自动修复');
    await lifecycle.repair().catch((error) => appendLog(`自动修复准备失败: ${formatError(error)}`));
    if (!runtimeIntent.isCurrent(intentGeneration)) return;
    const snapshot = await startProxy(undefined, intentGeneration);
    runtimeRecoveryFailures = 0;
    sendSnapshotToWindows(snapshot);
  } catch (error) {
    if (!runtimeIntent.isCurrent(intentGeneration)) return;
    runtimeRecoveryFailures += 1;
    recordError('自动恢复失败', error);
    await broadcastSnapshot().catch((broadcastError) => console.error('broadcast snapshot failed', broadcastError));
    scheduleRuntimeRecovery();
  } finally {
    runtimeRecoveryRunning = false;
    refreshTrayMenu();
  }
}

async function runNodeHealthCheck() {
  const generation = nodeHealthGeneration;
  const status = lifecycle.getStatus();
  let nextDelayMs = nodeHealthIntervalMs;
  if (status === 'failed') {
    scheduleRuntimeRecovery(nodeHealthRepairDelayMs);
    return;
  }
  if (nodeHealthCheckOwner || status !== 'running') {
    scheduleNodeHealthCheck();
    return;
  }

  const owner = Symbol('node-health-check');
  nodeHealthCheckOwner = owner;
  try {
    nextDelayMs = await ensureCurrentNodeUsable(generation);
  } catch (error) {
    if (!isCurrentNodeHealthGeneration(generation)) return;
    appendLog(`节点检查失败: ${formatError(error)}`);
    scheduleRuntimeRecovery(nodeHealthRepairDelayMs);
  } finally {
    if (nodeHealthCheckOwner === owner) {
      nodeHealthCheckOwner = undefined;
    }
    if (isCurrentNodeHealthGeneration(generation)) {
      scheduleNodeHealthCheck(nextDelayMs);
    }
  }
}

function isCurrentNodeHealthGeneration(generation: number): boolean {
  return generation === nodeHealthGeneration && lifecycle.getStatus() === 'running' && !isQuitting;
}

async function ensureCurrentNodeUsable(generation: number): Promise<number> {
  const settings = await settingsStore.read();
  if (!isCurrentNodeHealthGeneration(generation)) return nodeHealthIntervalMs;
  if (settings.mode === 'direct' || settings.strategy === 'direct') return nodeHealthIntervalMs;

  const mihomoApi = createRuntimeMihomoApi({ secret: settings.controllerSecret });
  const currentNode = await mihomoApi.getCurrentNode();
  if (!isCurrentNodeHealthGeneration(generation)) return nodeHealthIntervalMs;
  if (!currentNode || currentNode === 'DIRECT') return nodeHealthIntervalMs;

  const shouldPublishDelay = shouldRefreshCurrentNodeDelay(currentNode);
  if (shouldPublishDelay) {
    updateCurrentNodeDelay(currentNode, {
      delayStatus: 'testing',
      delay: undefined,
      delayCheckedAt: undefined
    });
    void broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
  }

  const currentDelay = await mihomoApi.testNodeDelay(currentNode).catch(() => undefined);
  if (!isCurrentNodeHealthGeneration(generation)) return nodeHealthIntervalMs;
  if (typeof currentDelay === 'number') {
    currentNodeHealthFailures = 0;
    currentNodeHealthFailureName = currentNode;
    if (shouldPublishDelay) {
      updateCurrentNodeDelay(currentNode, {
        delayStatus: 'measured',
        delay: currentDelay,
        delayCheckedAt: new Date().toISOString()
      });
      void broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
    }
    void maybeStartCurrentNodeAvailabilityCheck(currentNode);
    return nodeHealthIntervalMs;
  }

  if (shouldPublishDelay) {
    updateCurrentNodeDelay(currentNode, {
      delayStatus: 'failed',
      delay: undefined,
      delayCheckedAt: new Date().toISOString()
    });
    void broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
  }

  if (currentNodeHealthFailureName !== currentNode) {
    currentNodeHealthFailureName = currentNode;
    currentNodeHealthFailures = 0;
  }
  currentNodeHealthFailures += 1;
  if (currentNodeHealthFailures < nodeHealthFailureThreshold) {
    appendLog(`当前节点短暂异常，等待复查: ${currentNode}`);
    return nodeHealthRetryDelayMs;
  }

  appendLog(`当前节点不可用，正在切换: ${currentNode}`);
  const selectedNode = isAutomaticStrategy(settings.strategy)
    ? await mihomoApi.selectBestUsableNodeForStrategy(settings.strategy, { avoidNode: currentNode })
    : await mihomoApi.selectBestUsableNode({ avoidNode: currentNode });
  if (!isCurrentNodeHealthGeneration(generation)) return nodeHealthIntervalMs;
  if (!selectedNode) {
    throw new Error('没有可用节点');
  }

  await settingsStore.update(
    isAutomaticStrategy(settings.strategy)
      ? { strategy: settings.strategy, selectedNode: null }
      : { strategy: 'manual', selectedNode }
  );
  if (!isCurrentNodeHealthGeneration(generation)) return nodeHealthIntervalMs;
  await mihomoApi.closeConnections().catch((error) => appendLog(`关闭旧连接失败: ${formatError(error)}`));
  await mihomoApi.flushDnsCache().catch((error) => appendLog(`刷新 DNS 缓存失败: ${formatError(error)}`));
  if (!isCurrentNodeHealthGeneration(generation)) return nodeHealthIntervalMs;
  appendLog(`已切换可用节点: ${selectedNode}`);
  currentNodeHealthFailures = 0;
  currentNodeHealthFailureName = selectedNode;
  const snapshot = await createSnapshot();
  sendSnapshotToWindows(snapshot);
  return 0;
}

function isAutomaticStrategy(strategy: StrategyKey): strategy is Exclude<StrategyKey, 'manual' | 'direct'> {
  return strategy === 'auto' || strategy === 'fallback' || strategy === 'load-balance';
}

async function createSnapshot(): Promise<AppSnapshot> {
  const settings = await settingsStore.read();
  const mihomoApi = createMihomoApiClient({
    secret: settings.controllerSecret,
    controllerPort: runtimePorts.controllerPort
  });
  const running = lifecycle.getStatus() === 'running';
  const [nodes, strategies, runtime, currentNode] = running
    ? await Promise.all([
        mihomoApi.listNodes().catch(() => []),
        mihomoApi.listStrategies().catch(() => createDefaultStrategies(settings.strategy)),
        mihomoApi.getRuntimeStats().catch(() => ({ activeConnections: 0, uploadTotal: 0, downloadTotal: 0 })),
        mihomoApi.getCurrentNode().catch(() => strategyTargets.auto)
      ])
    : [
        [],
        createDefaultStrategies(settings.strategy),
        { activeConnections: 0, uploadTotal: 0, downloadTotal: 0 },
        strategyTargets[settings.strategy === 'manual' ? 'auto' : settings.strategy]
      ];
  const activeStrategy = strategies.find((strategy) => strategy.active)?.key ?? settings.strategy;
  const trafficSnapshot = await trafficStore.getSnapshot();
  const nodeHealth = await getCurrentNodeHealthSnapshot(currentNode, running);

  return {
    status: lifecycle.getStatus(),
    currentNode,
    nodes,
    nodeHealth,
    strategies,
    mode: settings.mode,
    strategy: activeStrategy,
    ruleProfile: settings.ruleProfile,
    features: {
      systemProxyEnabled: settings.systemProxyEnabled,
      dnsEnhanced: settings.dnsEnhanced,
      snifferEnabled: settings.snifferEnabled,
      tunEnabled: settings.tunEnabled,
      strictRouteEnabled: settings.strictRouteEnabled,
      allowLan: settings.allowLan,
      subscriptionRefreshIntervalHours: settings.subscriptionRefreshIntervalHours
    },
    runtime,
    traffic: trafficSnapshot.stats,
    trafficIdentity: trafficSnapshot.identity,
    subscriptionUrl: settings.subscriptionUrl,
    remoteSubscriptionUrl: settings.remoteSubscriptionUrl,
    subscriptionRevision,
    update: updateSnapshot,
    diagnostics: {
      lastError,
      logs: appLogs.getLogs(diagnosticSnapshotLogLimit),
      logCount: appLogs.size,
      logCapacity: appLogs.capacity,
      droppedLogCount: appLogs.droppedCount,
      issueKind: classifyDiagnosticIssue(lastError)
    }
  };
}

function sendSnapshotToWindows(snapshot: AppSnapshot) {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send(ipcChannels.snapshotUpdated, snapshot);
    }
  });
}

async function broadcastSnapshot(): Promise<AppSnapshot> {
  const snapshot = await createSnapshot();
  sendSnapshotToWindows(snapshot);
  return snapshot;
}

let trafficTotalsRefreshRunning = false;
async function refreshTrafficTotalsFromServer(): Promise<void> {
  if (trafficTotalsRefreshRunning) return;
  trafficTotalsRefreshRunning = true;
  try {
    await trafficReporter.reportPending();
    const snapshot = await createSnapshot();
    sendSnapshotToWindows(snapshot);
    refreshTrayMenu();
  } catch (error) {
    if (!isRecoverableSyncError(error)) {
      appendLog(`流量同步失败: ${formatError(error)}`);
    }
  } finally {
    trafficTotalsRefreshRunning = false;
  }
}

function createSnapshotProgressNotifier(intervalMs = 300, shouldSend: () => boolean = () => true) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let queued = false;
  let lastSentAt = 0;

  const schedule = () => {
    if (timer) return;
    const delayMs = Math.max(0, intervalMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = undefined;
      void send();
    }, delayMs);
  };

  const send = async () => {
    if (sending) {
      queued = true;
      return;
    }

    sending = true;
    queued = false;
    try {
      if (!shouldSend()) return;
      const snapshot = await createSnapshot();
      if (!shouldSend()) return;
      sendSnapshotToWindows(snapshot);
      lastSentAt = Date.now();
    } catch (error) {
      appendLog(`测速进度刷新失败: ${formatError(error)}`);
    } finally {
      sending = false;
      if (queued) {
        schedule();
      }
    }
  };

  return {
    notify() {
      queued = true;
      schedule();
    },
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      queued = false;
    }
  };
}

function createDefaultStrategies(active: string): StrategyGroup[] {
  return (Object.entries(strategyTargets) as Array<[Exclude<keyof typeof strategyTargets, 'manual'>, string]>).map(
    ([key, target]) => ({
      key,
      label: strategyLabels[key],
      target,
      active: active === key,
      now: undefined,
      delay: undefined
    })
  );
}

function createRuntimeMihomoApi(options: { secret: string }) {
  return createMihomoApiClient({
    ...options,
    controllerPort: runtimePorts.controllerPort
  });
}

async function withTrayRefresh<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } finally {
    refreshTrayMenu();
  }
}

async function startProxy(signal?: AbortSignal, requestedIntentGeneration?: number): Promise<AppSnapshot> {
  throwIfAborted(signal);
  throwIfNetworkRepairInProgress();
  if (requestedIntentGeneration !== undefined) throwIfRuntimeIntentCanceled(requestedIntentGeneration);
  await requireTrafficIdentity();
  const intentGeneration = requestedIntentGeneration ?? runtimeIntent.requestStart();
  throwIfRuntimeIntentCanceled(intentGeneration);
  await syncRemoteConfig({ signal });
  throwIfAborted(signal);
  throwIfRuntimeIntentCanceled(intentGeneration);
  await startLifecycleWithRepairRetry(signal, intentGeneration);
  throwIfAborted(signal);
  throwIfRuntimeIntentCanceled(intentGeneration);
  await trafficRegistration.activatePending();
  throwIfRuntimeIntentCanceled(intentGeneration);
  await syncRemoteConfig({
    proxyUrl: getRuntimeTrafficProxyUrl(),
    restartIfRunning: true,
    signal,
    intentGeneration
  });
  throwIfAborted(signal);
  throwIfRuntimeIntentCanceled(intentGeneration);
  trafficTracker.start();
  trafficReporter.start();
  clearLastError();
  scheduleNodeHealthCheck(0);
  return createSnapshot();
}

async function selectBestAutoNode(signal?: AbortSignal): Promise<AppSnapshot> {
  throwIfAborted(signal);
  await requireTrafficIdentity();
  const settings = await settingsStore.update({ strategy: 'auto', selectedNode: null });
  if (lifecycle.getStatus() !== 'running') {
    await startProxy(signal);
  }

  const mihomoApi = createRuntimeMihomoApi({ secret: settings.controllerSecret });
  const selectedNode = await mihomoApi.selectBestUsableNodeForStrategy('auto', { signal });
  throwIfAborted(signal);
  if (!selectedNode) {
    throw new Error('没有可用节点');
  }

  await mihomoApi.closeConnections().catch((error) => appendLog(`关闭旧连接失败: ${formatError(error)}`));
  await mihomoApi.flushDnsCache().catch((error) => appendLog(`刷新 DNS 缓存失败: ${formatError(error)}`));
  appendLog(`已自动选择可用节点: ${selectedNode}`);
  clearLastError();
  scheduleNodeHealthCheck(0);
  return createSnapshot();
}

async function selectVerifiedManualNode(
  mihomoApi: ReturnType<typeof createRuntimeMihomoApi>,
  requestedNode: string
): Promise<string> {
  const availableNodes = await mihomoApi.listNodes().catch(() => []);
  if (!availableNodes.some((node) => node.name === requestedNode)) {
    appendLog(`手动节点不存在，正在选择可用节点: ${requestedNode}`);
    const selectedNode = await mihomoApi.selectBestUsableNode({ avoidNode: requestedNode });
    if (!selectedNode) {
      throw new Error('没有可用节点');
    }
    return selectedNode;
  }

  const requestedDelay = await mihomoApi.testNodeDelay(requestedNode).catch(() => undefined);
  if (typeof requestedDelay === 'number') {
    await mihomoApi.selectNode(requestedNode);
    return requestedNode;
  }

  appendLog(`手动节点不可用，正在选择可用节点: ${requestedNode}`);
  const selectedNode = await mihomoApi.selectBestUsableNode({ avoidNode: requestedNode });
  if (!selectedNode) {
    throw new Error('没有可用节点');
  }
  return selectedNode;
}

async function requireTrafficIdentity(): Promise<void> {
  const snapshot = await trafficStore.getSnapshot();
  if (!snapshot.identity) {
    throw new Error('traffic identity required');
  }
}

function throwIfNetworkRepairInProgress(allowDuringNetworkRepair = false): void {
  if (networkRepairInProgress && !allowDuringNetworkRepair) {
    throw new Error('network repair already in progress');
  }
}

async function startLifecycleWithRepairRetry(
  signal?: AbortSignal,
  intentGeneration?: number,
  options: { allowDuringNetworkRepair?: boolean } = {}
): Promise<void> {
  throwIfNetworkRepairInProgress(options.allowDuringNetworkRepair);
  if (intentGeneration !== undefined) throwIfRuntimeIntentCanceled(intentGeneration);
  try {
    await lifecycle.start(signal);
  } catch (error) {
    throwIfAborted(signal);
    throwIfNetworkRepairInProgress(options.allowDuringNetworkRepair);
    if (intentGeneration !== undefined) throwIfRuntimeIntentCanceled(intentGeneration);
    appendLog(`启动失败，自动修复后重试: ${formatError(error)}`);
    await lifecycle.repair(signal).catch((repairError) => {
      appendLog(`自动修复失败: ${formatError(repairError)}`);
    });
    throwIfNetworkRepairInProgress(options.allowDuringNetworkRepair);
    if (intentGeneration !== undefined) throwIfRuntimeIntentCanceled(intentGeneration);
    await lifecycle.start(signal);
  }
  if (intentGeneration !== undefined) throwIfRuntimeIntentCanceled(intentGeneration);
}

async function startLifecycleForUser(signal?: AbortSignal): Promise<void> {
  throwIfNetworkRepairInProgress();
  const intentGeneration = runtimeIntent.requestStart();
  await startLifecycleWithRepairRetry(signal, intentGeneration);
}

async function restartLifecycleForUser(signal?: AbortSignal): Promise<void> {
  const intentGeneration = runtimeIntent.capture();
  if (intentGeneration === undefined) throw new Error('proxy start canceled');
  await restartLifecycleForIntent(intentGeneration, signal);
}

async function restartLifecycleForIntent(intentGeneration: number, signal?: AbortSignal): Promise<void> {
  throwIfNetworkRepairInProgress();
  throwIfRuntimeIntentCanceled(intentGeneration);
  try {
    await lifecycle.restart(signal);
  } catch (error) {
    throwIfAborted(signal);
    throwIfNetworkRepairInProgress();
    throwIfRuntimeIntentCanceled(intentGeneration);
    appendLog(`重启失败，自动修复后重试: ${formatError(error)}`);
    await lifecycle.repair(signal).catch((repairError) => {
      appendLog(`自动修复失败: ${formatError(repairError)}`);
    });
    throwIfNetworkRepairInProgress();
    throwIfRuntimeIntentCanceled(intentGeneration);
    await lifecycle.start(signal);
  }
  throwIfRuntimeIntentCanceled(intentGeneration);
}

function runtimeActionsForIntent(intentGeneration: number) {
  return {
    start: (signal?: AbortSignal) => startLifecycleWithRepairRetry(signal, intentGeneration),
    restart: (signal?: AbortSignal) => restartLifecycleForIntent(intentGeneration, signal)
  };
}

async function handleTrafficIdentityInvalidated(): Promise<void> {
  runtimeIntent.cancel();
  trafficTracker.stop();
  trafficReporter.stop();
  stopNodeHealthMonitor();
  clearRuntimeRecoveryTimer();
  clearSubscriptionRefreshTimer();
  await applyRemoteSubscription(undefined).catch((error) =>
    appendLog(`traffic identity invalidation subscription cleanup failed: ${formatError(error)}`)
  );

  await lifecycle
    .stop()
    .catch((error) => appendLog(`traffic identity invalidation stop failed: ${formatError(error)}`));
  await broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
  refreshTrayMenu();
}

async function stopProxy(): Promise<AppSnapshot> {
  runtimeIntent.cancel();
  await trafficTracker.flush().catch((error) => appendLog(`流量统计失败: ${formatError(error)}`));
  await trafficReporter.reportPending().catch((error) => appendLog(`流量上报失败: ${formatError(error)}`));
  trafficTracker.stop();
  await lifecycle.stop();
  return createSnapshot();
}

async function runIssueTargetedRepair(issueKind: DiagnosticIssueKind, signal?: AbortSignal): Promise<void> {
  const actions = getTargetedNetworkRepairActions(issueKind);
  if (actions.length === 0) return;
  appendLog(`按诊断执行针对性修复: ${issueKind}`);
  await runTargetedNetworkRepair(
    issueKind,
    {
      disableSystemProxy: (repairSignal) => systemProxy.disableForRepair(repairSignal),
      flushDns: (repairSignal) => systemProxy.flushDnsForRepair(repairSignal),
      stopKernel: () => mihomoRuntime.stop(),
      async refreshSubscription(repairSignal) {
        if (lifecycle.getStatus() !== 'running') return;
        const settings = await settingsStore.read();
        if (!settings.subscriptionUrl.trim()) throw new Error('missing subscription url');
        await createRuntimeMihomoApi({ secret: settings.controllerSecret }).updateProvider({ signal: repairSignal });
      }
    },
    signal
  );
}

async function repairProxy(signal?: AbortSignal, options: NetworkRepairOptions = {}): Promise<AppSnapshot> {
  throwIfAborted(signal);
  if (networkRepairInProgress) throw new Error('network repair already in progress');
  networkRepairInProgress = true;
  const repairOptions: NetworkRepairOptions = {
    ...options,
    issueKind: options.issueKind ?? classifyDiagnosticIssue(lastError)
  };
  let handingOffToRelaunch = false;
  try {
    const snapshot = await runNetworkRepair(
      {
        getStatus: () => lifecycle.getStatus(),
        captureRuntimeIntent: () => runtimeIntent.capture(),
        isRuntimeIntentCurrent: (generation) => runtimeIntent.isCurrent(generation),
        async prepareRunningRuntime() {
          const settings = await settingsStore.read().catch((error) => {
            appendLog(`读取设置失败，继续网络修复: ${formatError(error)}`);
            return undefined;
          });
          await trafficTracker.flush().catch((error) => appendLog(`流量统计失败: ${formatError(error)}`));
          await trafficReporter.reportPending().catch((error) => appendLog(`流量上报失败: ${formatError(error)}`));
          if (settings) {
            await createRuntimeMihomoApi({ secret: settings.controllerSecret })
              .closeConnections()
              .catch((error) => appendLog(`关闭旧连接失败: ${formatError(error)}`));
          }
        },
        pauseBackgroundWork() {
          trafficTracker.stop();
          trafficReporter.stop();
          stopNodeHealthMonitor();
          clearRuntimeRecoveryTimer();
          clearSubscriptionRefreshTimer();
          stopRemoteConfigPolling();
        },
        runTargetedRepair: runIssueTargetedRepair,
        onTargetedRepairError: (issueKind, error) =>
          appendLog(`针对性修复未完成，继续完整修复 (${issueKind}): ${formatError(error)}`),
        repairLifecycle: (repairSignal) => lifecycle.repair(repairSignal),
        clearRuntimeCache: () => clearMihomoRepairCache(userDataDir),
        startRuntime: (startSignal, intentGeneration) =>
          startLifecycleWithRepairRetry(startSignal, intentGeneration, { allowDuringNetworkRepair: true }),
        resumeRunningWork() {
          trafficTracker.start();
          trafficReporter.start();
          scheduleNodeHealthCheck(0);
        },
        async createSnapshot() {
          clearLastError();
          return createSnapshot();
        }
      },
      repairOptions,
      signal
    );
    handingOffToRelaunch = repairOptions.resumeRuntime === false;
    if (handingOffToRelaunch) lifecycle.suspendStarts();
    return snapshot;
  } finally {
    networkRepairInProgress = false;
    if (!handingOffToRelaunch) {
      startRemoteConfigPolling();
      scheduleSubscriptionRefresh();
    }
    if (lifecycle.getStatus() === 'failed') scheduleRuntimeRecovery(runtimeRecoveryInitialDelayMs);
  }
}

async function registerTrafficIdentity(input: Parameters<TrafficReporter['register']>[0]): Promise<AppSnapshot> {
  const previousIdentity = (await trafficStore.getSnapshot()).identity;
  const switchingVerifiedIdentity = Boolean(previousIdentity && previousIdentity.verificationStatus !== 'pending');
  const runtimeWasRunning = lifecycle.getStatus() === 'running';
  let trafficCollectionPaused = false;
  let postCommitIssue = false;
  const recordPostCommitIssue = (context: string, error: unknown) => {
    postCommitIssue = true;
    recordError(context, error);
  };
  const resumeTrafficCollection = () => {
    if (!trafficCollectionPaused || !runtimeWasRunning || lifecycle.getStatus() !== 'running') return;
    trafficTracker.start();
    trafficReporter.start();
  };

  let registrationResult: Awaited<ReturnType<typeof trafficRegistration.register>>;
  try {
    if (switchingVerifiedIdentity) {
      await trafficTracker.flush();
      trafficTracker.stop();
      trafficReporter.stop();
      trafficCollectionPaused = true;
      await trafficReporter.reportPending();
      const settled = await trafficStore.getSnapshot();
      if (
        settled.stats.pendingUpload > 0 ||
        settled.stats.pendingDownload > 0 ||
        settled.stats.totalSource !== 'server'
      ) {
        throw new Error('当前用户用量尚未同步，请稍后重试');
      }
    }

    registrationResult = await trafficRegistration.register(input, {
      preserveExistingIdentity: switchingVerifiedIdentity
    });
  } catch (error) {
    resumeTrafficCollection();
    throw error;
  }

  if (registrationResult.postCommitError) {
    recordPostCommitIssue(
      '\u7528\u6237\u5df2\u5207\u6362\uff0c\u4e34\u65f6\u4ee3\u7406\u6536\u5c3e\u5931\u8d25',
      registrationResult.postCommitError
    );
  }

  try {
    const nextIdentity = (await trafficStore.getSnapshot()).identity;
    const identityChanged =
      !previousIdentity ||
      !nextIdentity ||
      previousIdentity.userId !== nextIdentity.userId ||
      previousIdentity.deviceId !== nextIdentity.deviceId ||
      previousIdentity.verificationStatus !== nextIdentity.verificationStatus;

    if (identityChanged) {
      try {
        await applyRemoteSubscription(undefined);
      } catch (error) {
        recordPostCommitIssue(
          '\u7528\u6237\u5df2\u5207\u6362\uff0c\u65e7\u8fdc\u7a0b\u914d\u7f6e\u6e05\u7406\u5931\u8d25',
          error
        );
      }
      const activeIntentGeneration = runtimeIntent.capture();
      const newIntentGeneration = activeIntentGeneration === undefined ? undefined : runtimeIntent.requestStart();
      try {
        await syncRemoteConfig({
          proxyUrl: getRuntimeTrafficProxyUrl(),
          throwOnError: true
        });
      } catch (error) {
        recordPostCommitIssue(
          '\u7528\u6237\u5df2\u5207\u6362\uff0c\u65b0\u7528\u6237\u914d\u7f6e\u540c\u6b65\u5931\u8d25',
          error
        );
      }
      if (newIntentGeneration !== undefined) {
        try {
          await restartLifecycleForIntent(newIntentGeneration);
          trafficTracker.start();
          trafficReporter.start();
        } catch (error) {
          recordPostCommitIssue('\u7528\u6237\u5df2\u5207\u6362\uff0c\u4ee3\u7406\u91cd\u542f\u5931\u8d25', error);
        }
      }
    } else if (lifecycle.getStatus() === 'running') {
      try {
        await syncRemoteConfig({
          proxyUrl: getRuntimeTrafficProxyUrl(),
          restartIfRunning: true,
          throwOnError: true,
          intentGeneration: runtimeIntent.capture()
        });
        trafficTracker.start();
        trafficReporter.start();
      } catch (error) {
        recordPostCommitIssue(
          '\u7528\u6237\u5df2\u767b\u8bb0\uff0c\u8fdc\u7a0b\u914d\u7f6e\u5237\u65b0\u5931\u8d25',
          error
        );
      }
    }
    startRemoteConfigPolling();
    if (!postCommitIssue) clearLastError();
    return createSnapshot();
  } finally {
    resumeTrafficCollection();
  }
}

async function cancelProxyStart(): Promise<void> {
  runtimeIntent.cancel();
  await lifecycle.stop();
}

function throwIfRuntimeIntentCanceled(generation: number): void {
  if (!runtimeIntent.isCurrent(generation)) {
    throw new Error('proxy start canceled');
  }
}

async function restartKernelAndApp(preparedSnapshot?: AppSnapshot): Promise<AppSnapshot> {
  if (!preparedSnapshot) await requireTrafficIdentity();
  clearLastError();
  const snapshot = preparedSnapshot ?? (await createSnapshot());
  await cleanupBeforeExit({
    relaunchArgs: buildProxyRelaunchArguments(process.argv.slice(1)),
    throwOnFailure: true
  });
  return snapshot;
}

async function repairNetworkAndRestartApp(): Promise<AppSnapshot> {
  await requireTrafficIdentity();
  const snapshot = await repairProxy(undefined, { resumeRuntime: false });
  return restartKernelAndApp(snapshot);
}

function registerIpc() {
  ipcMain.handle(ipcChannels.getSnapshot, createSnapshot);
  ipcMain.handle(ipcChannels.wavePet, async () => {
    return undefined;
  });
  ipcMain.handle(ipcChannels.startPetDrag, async () => {
    startPetDrag();
  });
  ipcMain.handle(ipcChannels.stopPetDrag, async (_event, moved?: boolean) => {
    return stopPetDrag({ settle: Boolean(moved) });
  });
  ipcMain.handle(ipcChannels.setPetMousePassthrough, async (_event, passthrough?: boolean) => {
    setPetMousePassthrough(Boolean(passthrough));
  });
  ipcMain.handle(ipcChannels.showMainWindow, async () => {
    showMainWindow();
  });
  ipcMain.handle(ipcChannels.start, async (event, request?: OperationRequest) => {
    return runCancelableOperation(
      event.sender.id,
      request,
      async (signal) =>
        withTrayRefresh(async () => {
          try {
            const snapshot = await startProxy(signal);
            sendSnapshotToWindows(snapshot);
            return snapshot;
          } catch (error) {
            recordError('启动失败', error);
            throw error;
          }
        }),
      cancelProxyStart
    );
  });
  ipcMain.handle(ipcChannels.stop, async (event, request?: OperationRequest) => {
    return runCancelableOperation(event.sender.id, request, async () =>
      withTrayRefresh(async () => {
        try {
          const snapshot = await stopProxy();
          sendSnapshotToWindows(snapshot);
          return snapshot;
        } catch (error) {
          recordError('停止失败', error);
          throw error;
        }
      })
    );
  });
  ipcMain.handle(ipcChannels.repair, async (event, request?: OperationRequest) => {
    return runCancelableOperation(
      event.sender.id,
      request,
      async (signal) =>
        withTrayRefresh(async () => {
          throwIfAborted(signal);
          try {
            const snapshot = await repairProxy(signal);
            throwIfAborted(signal);
            sendSnapshotToWindows(snapshot);
            return snapshot;
          } catch (error) {
            recordError('修复失败', error);
            throw error;
          }
        }),
      cancelProxyStart
    );
  });
  ipcMain.handle(ipcChannels.selectNode, async (_event, name: string) => {
    const settings = await settingsStore.read();
    if (lifecycle.getStatus() !== 'running') {
      await requireTrafficIdentity();
      await startLifecycleForUser();
    }
    const mihomoApi = createMihomoApiClient({
      secret: settings.controllerSecret,
      controllerPort: runtimePorts.controllerPort
    });
    const selectedNode = await selectVerifiedManualNode(mihomoApi, name);
    await settingsStore.update({ strategy: 'manual', selectedNode });
    await mihomoApi.closeConnections().catch((error) => appendLog(`关闭旧连接失败: ${formatError(error)}`));
    await mihomoApi.flushDnsCache().catch((error) => appendLog(`刷新 DNS 缓存失败: ${formatError(error)}`));
    scheduleNodeHealthCheck(0);
    return createSnapshot();
  });
  ipcMain.handle(ipcChannels.selectBestAutoNode, async (event, request?: OperationRequest) => {
    return runCancelableOperation(
      event.sender.id,
      request,
      async (signal) =>
        withTrayRefresh(async () => {
          try {
            const snapshot = await selectBestAutoNode(signal);
            sendSnapshotToWindows(snapshot);
            return snapshot;
          } catch (error) {
            recordError('自动选择节点失败', error);
            throw error;
          }
        }),
      cancelProxyStart
    );
  });
  ipcMain.handle(ipcChannels.selectStrategy, async (_event, strategy) => {
    const snapshot = await selectMihomoStrategy(
      {
        settingsStore,
        lifecycle,
        runtime: userRuntimeActions,
        createMihomoApi: createRuntimeMihomoApi,
        createSnapshot
      },
      strategy
    );
    scheduleNodeHealthCheck(0);
    return snapshot;
  });
  ipcMain.handle(ipcChannels.setMode, async (_event, mode) => {
    const snapshot = await setMihomoMode(
      {
        settingsStore,
        lifecycle,
        createMihomoApi: createRuntimeMihomoApi,
        createSnapshot
      },
      mode
    );
    scheduleNodeHealthCheck(0);
    return snapshot;
  });
  ipcMain.handle(ipcChannels.testNode, async (_event, name: string) => {
    await requireTrafficIdentity();
    return testMihomoNode(
      {
        settingsStore,
        lifecycle,
        runtime: userRuntimeActions,
        createMihomoApi: createRuntimeMihomoApi,
        createSnapshot
      },
      name,
      {
        onDelayTested: async (nodeName, delay) => {
          await updateCurrentNodeDelayFromManualTest(nodeName, delay);
        }
      }
    );
  });
  ipcMain.handle(ipcChannels.testAllNodes, async () => {
    await requireTrafficIdentity();
    activeNodeTestController?.abort();
    const controller = new AbortController();
    const progressNotifier = createSnapshotProgressNotifier(300, () => {
      return activeNodeTestController === controller && !controller.signal.aborted;
    });
    activeNodeTestController = controller;
    try {
      const snapshot = await testAllMihomoNodes(
        {
          settingsStore,
          lifecycle,
          runtime: userRuntimeActions,
          createMihomoApi: createRuntimeMihomoApi,
          createSnapshot
        },
        {
          signal: controller.signal,
          onNodeTested: async (node) => {
            await updateCurrentNodeDelayFromManualTest(node.name, node.delay, node.testState);
          },
          onProgress: () => {
            if (activeNodeTestController === controller && !controller.signal.aborted) {
              progressNotifier.notify();
            }
          }
        }
      );
      sendSnapshotToWindows(snapshot);
      return snapshot;
    } finally {
      progressNotifier.clear();
      if (activeNodeTestController === controller) {
        activeNodeTestController = undefined;
      }
    }
  });
  ipcMain.handle(ipcChannels.cancelNodeTests, async () => {
    activeNodeTestController?.abort();
    activeNodeTestController = undefined;
    const snapshot = await createSnapshot();
    sendSnapshotToWindows(snapshot);
    return snapshot;
  });
  ipcMain.handle(ipcChannels.testConnectivity, async (event, key, request?: OperationRequest) => {
    return runCancelableOperation(event.sender.id, request, (signal) =>
      testConnectivity(
        {
          getMixedPort: () => runtimePorts.mixedPort,
          getControllerPort: () => runtimePorts.controllerPort,
          getControllerSecret: async () => (await settingsStore.read()).controllerSecret,
          isRunning: () => lifecycle.getStatus() === 'running'
        },
        key,
        { signal }
      )
    );
  });
  ipcMain.handle(ipcChannels.testAllConnectivity, async () => {
    return testAllConnectivity({
      getMixedPort: () => runtimePorts.mixedPort,
      getControllerPort: () => runtimePorts.controllerPort,
      getControllerSecret: async () => (await settingsStore.read()).controllerSecret,
      isRunning: () => lifecycle.getStatus() === 'running'
    });
  });
  ipcMain.handle(ipcChannels.closeConnections, async () => {
    return closeMihomoConnections({
      settingsStore,
      lifecycle,
      createMihomoApi: createRuntimeMihomoApi,
      createSnapshot
    });
  });
  ipcMain.handle(ipcChannels.updateSubscription, async (event, request?: OperationRequest) => {
    return runCancelableOperation(
      event.sender.id,
      request,
      async (signal) =>
        withTrayRefresh(async () => {
          throwIfAborted(signal);
          await requireTrafficIdentity();
          await updateSubscriptionNodes(
            {
              settingsStore,
              lifecycle,
              runtime: userRuntimeActions,
              createMihomoApi: createRuntimeMihomoApi,
              createSnapshot
            },
            { signal }
          );
          throwIfAborted(signal);
          subscriptionRevision += 1;
          scheduleSubscriptionRefresh();
          return createSnapshot();
        }),
      cancelProxyStart
    );
  });
  ipcMain.handle(ipcChannels.saveSettings, async (event, settings, request?: OperationRequest) => {
    return runCancelableOperation(
      event.sender.id,
      request,
      async (signal) =>
        withTrayRefresh(async () => {
          const lastErrorBeforeSave = lastError;
          const issueBeforeSave = classifyDiagnosticIssue(lastErrorBeforeSave);
          try {
            await saveSubscriptionSettings(
              { settingsStore, lifecycle, runtime: userRuntimeActions, createSnapshot },
              settings,
              { signal }
            );
            if (isDiagnosticIssueResolvedByOperation('save-settings', issueBeforeSave)) {
              clearLastErrorIfUnchanged(lastErrorBeforeSave);
            }
            scheduleSubscriptionRefresh();
            return createSnapshot();
          } catch (error) {
            recordError('保存设置失败', error);
            throw error;
          }
        }),
      cancelProxyStart
    );
  });
  ipcMain.handle(ipcChannels.registerTrafficIdentity, async (_event, input) => {
    const snapshot = await registerTrafficIdentity(input);
    sendSnapshotToWindows(snapshot);
    return snapshot;
  });
  ipcMain.handle(ipcChannels.syncRemoteConfig, async (event, request?: OperationRequest) => {
    return runCancelableOperation(
      event.sender.id,
      request,
      async (signal) =>
        withTrayRefresh(async () => {
          const lastErrorBeforeSync = lastError;
          const issueBeforeSync = classifyDiagnosticIssue(lastErrorBeforeSync);
          try {
            await requireTrafficIdentity();
            await syncRemoteConfig({
              proxyUrl: getRuntimeTrafficProxyUrl(),
              restartIfRunning: true,
              throwOnError: true,
              signal,
              intentGeneration: runtimeIntent.capture()
            });
            if (isDiagnosticIssueResolvedByOperation('sync-settings', issueBeforeSync)) {
              clearLastErrorIfUnchanged(lastErrorBeforeSync);
            }
            return createSnapshot();
          } catch (error) {
            recordError('同步设置失败', error);
            throw error;
          }
        }),
      cancelProxyStart
    );
  });
  ipcMain.handle(ipcChannels.exportDiagnostics, async () => {
    try {
      return await exportCurrentDiagnostics();
    } catch (error) {
      recordError('导出诊断日志失败', error);
      throw error;
    }
  });
  ipcMain.handle(ipcChannels.cancelOperation, (event, requestId: string) => {
    return ipcOperations.cancel(event.sender.id, requestId);
  });
  ipcMain.handle(ipcChannels.checkForUpdates, async () => {
    return checkForUpdatesNow(true);
  });
  ipcMain.handle(ipcChannels.installUpdate, async () => {
    return installDownloadedUpdate();
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('operation canceled');
  }
}

async function runCancelableOperation<T>(
  senderId: number,
  request: OperationRequest | undefined,
  action: (signal: AbortSignal) => Promise<T>,
  onAbort?: () => Promise<unknown>
): Promise<T> {
  return ipcOperations.run(senderId, request, action, onAbort);
}

function showMainWindow() {
  if (!mainWindow) {
    void createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function sendPetState() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send(ipcChannels.petStateUpdated, petState);
}

function setPetState(state: DesktopPetState, durationMs?: number) {
  if (petState !== state) {
    petState = state;
    sendPetState();
  }

  if (petAnimationTimer) {
    clearTimeout(petAnimationTimer);
    petAnimationTimer = undefined;
  }

  if (durationMs) {
    petAnimationTimer = setTimeout(() => {
      petAnimationTimer = undefined;
      syncPetStateToRuntime();
    }, durationMs);
  }

  updatePetDockBehavior(state, Boolean(durationMs));
}

function clearPetDockTimer() {
  if (!petDockTimer) return;
  clearTimeout(petDockTimer);
  petDockTimer = undefined;
}

function clearPetSequenceTimer() {
  if (!petSequenceTimer) return;
  clearTimeout(petSequenceTimer);
  petSequenceTimer = undefined;
}

function clearPetMoveTimer() {
  if (!petMoveTimer) return;
  clearInterval(petMoveTimer);
  petMoveTimer = undefined;
}

function clearPetDockBehavior() {
  clearPetDockTimer();
  petDockBehavior = undefined;
}

function updatePetDockBehavior(state: DesktopPetState, temporary = false) {
  if (!petFeatureEnabled || temporary) return;

  if (state === 'edgeLeft' || state === 'edgeRight') {
    if (petDockBehavior?.kind !== 'side' || petDockBehavior.side !== state) {
      petDockBehavior = { kind: 'side', side: state, startedAt: Date.now() };
    }
    scheduleSideDockBehavior();
    return;
  }

  if (state === 'edgeLeftSleep' || state === 'edgeRightSleep') {
    const side = state === 'edgeLeftSleep' ? 'edgeLeft' : 'edgeRight';
    if (petDockBehavior?.kind !== 'side' || petDockBehavior.side !== side) {
      petDockBehavior = { kind: 'side', side, startedAt: Date.now() - petSideSleepDelayMs };
    }
    scheduleSideDockBehavior();
    return;
  }

  if (state === 'topSleep') {
    if (petDockBehavior?.kind !== 'top') {
      petDockBehavior = { kind: 'top', startedAt: Date.now() };
    }
    scheduleTopDockBehavior();
    return;
  }

  clearPetDockBehavior();
}

function scheduleSideDockBehavior() {
  if (petDockBehavior?.kind !== 'side') return;
  clearPetDockTimer();

  const elapsed = Date.now() - petDockBehavior.startedAt;
  if (elapsed >= petSideDropDelayMs) {
    petDockTimer = setTimeout(() => dropPetToBottom('side'), 0);
    return;
  }

  if (elapsed >= petSideSleepDelayMs) {
    const sleepState = getSideSleepState(petDockBehavior.side);
    if (petState !== sleepState) {
      setPetState(sleepState);
      return;
    }
    petDockTimer = setTimeout(() => dropPetToBottom('side'), petSideDropDelayMs - elapsed);
    return;
  }

  petDockTimer = setTimeout(
    () => {
      if (petDockBehavior?.kind !== 'side') return;
      setPetState(getSideBlinkState(petDockBehavior.side), 900);
    },
    Math.min(petSideBlinkDelayMs, petSideSleepDelayMs - elapsed)
  );
}

function scheduleTopDockBehavior() {
  if (petDockBehavior?.kind !== 'top') return;
  clearPetDockTimer();

  const elapsed = Date.now() - petDockBehavior.startedAt;
  petDockTimer = setTimeout(() => dropPetToBottom('top'), Math.max(0, petTopDropDelayMs - elapsed));
}

function getSideBlinkState(side: 'edgeLeft' | 'edgeRight'): DesktopPetState {
  return side === 'edgeLeft' ? 'edgeLeftBlink' : 'edgeRightBlink';
}

function getSideSleepState(side: 'edgeLeft' | 'edgeRight'): DesktopPetState {
  return side === 'edgeLeft' ? 'edgeLeftSleep' : 'edgeRightSleep';
}

function syncPetStateToRuntime() {
  if (!petFeatureEnabled) return;
  if (petAnimationTimer) return;
  if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
    const dockState = getPetDockState(petWindow.getBounds());
    if (dockState) {
      setPetState(dockState);
      return;
    }
  }

  const status = lifecycle.getStatus();
  if (trayBusy) {
    setPetState('focusWait');
    return;
  }

  if (status === 'running') {
    setPetState('happy');
    return;
  }

  if (status === 'failed') {
    setPetState('comfortSad');
    return;
  }

  setPetState('idle');
}

function showPetWindow() {
  if (!petFeatureEnabled) return;
  petVisibilityController.setUserRequestedVisible(true);
  if (!petWindow) {
    void createPetWindow();
    return;
  }

  applyPetWindowVisibility();
  refreshTrayMenu();
}

function hidePetWindow() {
  if (!petFeatureEnabled) return;
  petVisibilityController.setUserRequestedVisible(false);
  refreshTrayMenu();
}

function togglePetWindow() {
  if (!petFeatureEnabled) return;
  if (petVisibilityController.isUserRequestedVisible()) {
    hidePetWindow();
    return;
  }

  showPetWindow();
}

function applyPetWindowVisibility(visible = petVisibilityController.isVisible()) {
  if (!petWindow || petWindow.isDestroyed()) return;

  if (!visible) {
    stopPetDrag({ settle: false });
    clearPetDockBehavior();
    clearPetSequenceTimer();
    clearPetMoveTimer();
    setPetMousePassthrough(true, true);
    petWindow.setAlwaysOnTop(false);
    petWindow.hide();
    setPetState('idle');
    refreshTrayMenu();
    return;
  }

  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.showInactive();
  applyPetWindowTaskbarPolicy(petWindow);
  setPetMousePassthrough(true, true);
  syncPetStateToRuntime();
  refreshTrayMenu();
}

async function startPetFullscreenProbe(window: BrowserWindow) {
  const generation = ++petFullscreenProbeGeneration;
  petFullscreenProbe?.stop();
  petFullscreenProbe = undefined;
  petFullscreenSuppressionStabilizer.reset();
  if (process.platform !== 'win32') return;

  try {
    if (!petFullscreenProbeHelperPath) {
      const sourcePath = app.isPackaged
        ? join(process.resourcesPath, 'windows-fullscreen-probe.exe')
        : join(app.getAppPath(), 'resources', 'generated', 'windows-fullscreen-probe.exe');
      petFullscreenProbeHelperPath = await prepareWindowsFullscreenProbeExecutable({
        sourcePath,
        runtimeDirectory: join(userDataDir, 'runtime', 'helpers')
      });
    }
    if (
      generation !== petFullscreenProbeGeneration ||
      petWindow !== window ||
      window.isDestroyed() ||
      isQuitting ||
      cleanupStarted
    ) {
      return;
    }
    petFullscreenProbe = startWindowsFullscreenProbe({
      helperPath: petFullscreenProbeHelperPath,
      petWindowHandle: getNativeWindowHandleDecimal(window.getNativeWindowHandle()),
      onSample: (fullscreenOnPetMonitor) => {
        petFullscreenProbeErrorLogged = false;
        petFullscreenSuppressionStabilizer.update(fullscreenOnPetMonitor);
      },
      onError: (error) => {
        petFullscreenSuppressionStabilizer.reset();
        if (petFullscreenProbeErrorLogged) return;
        petFullscreenProbeErrorLogged = true;
        appendLog(`桌宠全屏避让暂不可用，保持显示: ${formatError(error)}`);
      }
    });
  } catch (error) {
    if (generation !== petFullscreenProbeGeneration) return;
    petFullscreenSuppressionStabilizer.reset();
    if (!petFullscreenProbeErrorLogged) {
      petFullscreenProbeErrorLogged = true;
      appendLog(`桌宠全屏避让初始化失败，保持显示: ${formatError(error)}`);
    }
  }
}

function stopPetFullscreenProbe(options: { restoreVisibility?: boolean } = {}) {
  petFullscreenProbeGeneration += 1;
  petFullscreenProbe?.stop();
  petFullscreenProbe = undefined;
  petFullscreenProbeErrorLogged = false;
  if (options.restoreVisibility !== false) {
    petFullscreenSuppressionStabilizer.reset();
  }
}

function restartPetFullscreenProbe() {
  if (!petFeatureEnabled || !petWindow || petWindow.isDestroyed()) return;
  void startPetFullscreenProbe(petWindow);
}

function isLaunchAtLoginEnabled(): boolean {
  if (process.platform !== 'win32') {
    return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin;
  }

  return windowsStartupTask.isEnabled() || isLegacyLaunchAtLoginEnabled();
}

function clearLegacyLaunchAtLogin() {
  app.setLoginItemSettings({
    openAtLogin: false,
    openAsHidden: false,
    path: process.execPath,
    args: ['--hidden']
  });
}

function isLegacyLaunchAtLoginEnabled(): boolean {
  return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin;
}

async function setLaunchAtLogin(enabled: boolean) {
  if (process.platform !== 'win32') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled,
      path: process.execPath,
      args: enabled ? ['--hidden'] : []
    });
    return;
  }

  await windowsStartupTask.setEnabled(enabled);
  clearLegacyLaunchAtLogin();
}

async function toggleLaunchAtLogin(enabled: boolean) {
  try {
    await setLaunchAtLogin(enabled);
  } catch (error) {
    recordError('设置开机自启失败', error);
  } finally {
    refreshTrayMenu();
  }
}

async function reconcileLaunchAtLogin() {
  if (process.platform !== 'win32') return;

  try {
    await windowsStartupTask.reconcile(isLegacyLaunchAtLoginEnabled());
    clearLegacyLaunchAtLogin();
  } catch (error) {
    recordError('同步开机自启失败', error);
  }
}

function showPetContextMenu() {
  if (!petFeatureEnabled) return;
  const running = lifecycle.getStatus() === 'running';
  const proxyActionLabel = running ? '停止代理' : '启动代理';
  const menu = Menu.buildFromTemplate([
    {
      label: '打开窗口',
      click: showMainWindow
    },
    {
      label: proxyActionLabel,
      enabled: !trayBusy,
      click: () => {
        void runTrayAction(proxyActionLabel, async () => {
          return running ? stopProxy() : startProxy();
        });
      }
    },
    {
      label: '右下贴边',
      click: () => {
        void dockPetToBottomRight();
      }
    },
    {
      label: '隐藏',
      click: hidePetWindow
    },
    { type: 'separator' },
    {
      label: '退出',
      enabled: !isUpdateInstallerHandoffPending(),
      click: () => {
        if (isUpdateInstallerHandoffPending()) {
          showMainWindow();
          return;
        }
        isQuitting = true;
        void cleanupBeforeExit();
      }
    }
  ]);
  menu.popup({ window: petWindow ?? undefined });
}

function getDefaultPetBounds() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  return getBottomRightEdgeBounds(area);
}

function getBottomRightEdgeBounds(area: Rectangle): Rectangle {
  return {
    width: petWindowSize.width,
    height: petWindowSize.height,
    x: area.x + area.width - petWindowSize.width,
    y: area.y + area.height - petWindowSize.height
  };
}

function getBottomDockBounds(area: Rectangle, preferredX: number): Rectangle {
  const minX = area.x + Math.round(petWindowSize.width * 0.45);
  const maxX = area.x + area.width - petWindowSize.width - Math.round(petWindowSize.width * 0.45);
  const fallbackX = area.x + Math.round((area.width - petWindowSize.width) / 2);
  const x = maxX > minX ? Math.min(Math.max(preferredX, minX), maxX) : fallbackX;

  return {
    width: petWindowSize.width,
    height: petWindowSize.height,
    x,
    y: area.y + area.height - petWindowSize.height
  };
}

async function getPetStartBounds() {
  const settings = await settingsStore.read();
  if (!settings.petWindow) return getDefaultPetBounds();

  return clampPetBounds({
    ...petWindowSize,
    x: settings.petWindow.x,
    y: settings.petWindow.y
  });
}

function clampPetBounds(bounds: Rectangle, area = screen.getDisplayMatching(bounds).workArea): Rectangle {
  const maxX = area.x + area.width - bounds.width;
  const maxY = area.y + area.height - bounds.height;

  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, area.x), maxX),
    y: Math.min(Math.max(bounds.y, area.y), maxY)
  };
}

function getPetDockState(bounds: Rectangle): DesktopPetState | undefined {
  const area = screen.getDisplayMatching(bounds).workArea;
  const edgeDistance = 18;
  const maxX = area.x + area.width - bounds.width;
  const maxY = area.y + area.height - bounds.height;
  const nearLeft = Math.abs(bounds.x - area.x) <= edgeDistance;
  const nearRight = Math.abs(maxX - bounds.x) <= edgeDistance;
  const nearTop = Math.abs(bounds.y - area.y) <= edgeDistance;
  const nearBottom = Math.abs(maxY - bounds.y) <= edgeDistance;

  if (nearTop && !nearLeft && !nearRight) return 'topSleep';
  if (nearBottom && !nearLeft && !nearRight) return 'bottomSleep';

  const distances = [
    { state: 'edgeLeft' as const, distance: Math.abs(bounds.x - area.x) },
    { state: 'edgeRight' as const, distance: Math.abs(maxX - bounds.x) }
  ].filter((candidate) => candidate.distance <= edgeDistance);

  distances.sort((a, b) => a.distance - b.distance);
  return distances[0]?.state;
}

function settlePetBounds(bounds: Rectangle): { bounds: Rectangle; dockState?: DesktopPetState } {
  const area = screen.getDisplayMatching(bounds).workArea;
  const edgeDistance = 44;
  const maxX = area.x + area.width - bounds.width;
  const maxY = area.y + area.height - bounds.height;
  let x = Math.min(Math.max(bounds.x, area.x), maxX);
  let y = Math.min(Math.max(bounds.y, area.y), maxY);

  if (Math.abs(x - area.x) <= edgeDistance) {
    x = area.x;
  } else if (Math.abs(maxX - x) <= edgeDistance) {
    x = maxX;
  }

  if (Math.abs(y - area.y) <= edgeDistance) {
    y = area.y;
  } else if (Math.abs(maxY - y) <= edgeDistance) {
    y = maxY;
  }

  const nextBounds = {
    ...bounds,
    x,
    y
  };

  return {
    bounds: nextBounds,
    dockState: getPetDockState(nextBounds)
  };
}

function savePetBounds(bounds: Rectangle) {
  void settingsStore.update({
    petWindow: {
      x: bounds.x,
      y: bounds.y
    }
  });
}

function setPetMousePassthrough(passthrough: boolean, force = false) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!force && petMousePassthrough === passthrough) return;

  petMousePassthrough = passthrough;
  if (passthrough) {
    petWindow.setIgnoreMouseEvents(true, { forward: true });
    return;
  }

  petWindow.setIgnoreMouseEvents(false);
}

async function dockPetToBottomRight() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const area = screen.getDisplayMatching(petWindow.getBounds()).workArea;
  const bounds = getBottomRightEdgeBounds(area);
  petWindow.setBounds(bounds, false);
  savePetBounds(bounds);
  setPetState('edgeRight');
}

function dropPetToBottom(_source: 'side' | 'top') {
  if (!petWindow || petWindow.isDestroyed()) return;
  const current = petWindow.getBounds();
  const area = screen.getDisplayMatching(current).workArea;
  const bounds = getBottomDockBounds(area, current.x);

  clearPetDockBehavior();
  clearPetSequenceTimer();
  setPetState('fallRecover');
  animatePetBounds(bounds, 620, () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    petWindow.setBounds(bounds, false);
    savePetBounds(bounds);
    playPetBottomSequence(['bottomDizzy', 'bottomAngry', 'idle', 'bottomSleep']);
  });
}

function animatePetBounds(target: Rectangle, durationMs: number, onDone: () => void) {
  if (!petWindow || petWindow.isDestroyed()) return;
  clearPetMoveTimer();

  const start = petWindow.getBounds();
  const startedAt = Date.now();
  petMoveTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) {
      clearPetMoveTimer();
      return;
    }

    const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    petWindow.setBounds(
      {
        ...target,
        x: Math.round(start.x + (target.x - start.x) * eased),
        y: Math.round(start.y + (target.y - start.y) * eased)
      },
      false
    );

    if (progress >= 1) {
      clearPetMoveTimer();
      onDone();
    }
  }, petDragFrameMs);
}

function playPetBottomSequence(states: DesktopPetState[], onDone?: () => void) {
  const [state, ...rest] = states;
  if (!state) {
    onDone?.();
    return;
  }

  setPetState(state);
  if (rest.length === 0 && !onDone) return;

  const holdMs = getPetBottomSequenceHoldMs(state);
  clearPetSequenceTimer();
  petSequenceTimer = setTimeout(() => {
    petSequenceTimer = undefined;
    playPetBottomSequence(rest, onDone);
  }, holdMs);
}

function getPetBottomSequenceHoldMs(state: DesktopPetState): number {
  if (state === 'bottomDizzy') return 650;
  if (state === 'bottomAngry') return 850;
  if (state === 'idle') return 4200;
  return 950;
}

function startPetDrag() {
  if (!petWindow || petDragTimer) return;
  setPetMousePassthrough(false);
  clearPetDockBehavior();
  clearPetSequenceTimer();
  clearPetMoveTimer();

  const cursor = screen.getCursorScreenPoint();
  const bounds = petWindow.getBounds();
  petDragStart = {
    cursorX: cursor.x,
    cursorY: cursor.y,
    windowX: bounds.x,
    windowY: bounds.y
  };
  petDragTimer = setInterval(() => {
    if (!petWindow || !petDragStart) return;
    const nextCursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(nextCursor).workArea;
    petWindow.setBounds(
      clampPetBounds(
        {
          x: petDragStart.windowX + nextCursor.x - petDragStart.cursorX,
          y: petDragStart.windowY + nextCursor.y - petDragStart.cursorY,
          ...petWindowSize
        },
        area
      ),
      false
    );
  }, petDragFrameMs);
}

function stopPetDrag(options: { settle?: boolean } = {}): DesktopPetState | undefined {
  const shouldSettle = Boolean(options.settle);
  if (petDragTimer) {
    clearInterval(petDragTimer);
    petDragTimer = undefined;
  }
  petDragStart = undefined;

  if (!petWindow || petWindow.isDestroyed()) return undefined;

  if (shouldSettle) {
    const settled = settlePetBounds(petWindow.getBounds());
    petWindow.setBounds(settled.bounds, false);
    savePetBounds(settled.bounds);
    const nextState: DesktopPetState = settled.dockState ?? 'fallRecover';
    if (settled.dockState) {
      setPetState(settled.dockState);
      return nextState;
    }
    setPetState('fallRecover');
    playPetBottomSequence(['bottomDizzy', 'bottomAngry', 'idle'], syncPetStateToRuntime);
    return 'fallRecover';
  }

  syncPetStateToRuntime();
  return undefined;
}

function refreshTrayMenu() {
  if (!tray) return;

  const status = lifecycle.getStatus();
  const running = status === 'running';
  const failed = status === 'failed';
  const launchAtLogin = isLaunchAtLoginEnabled();
  const statusLabel = trayBusy ? '处理中' : running ? '运行中' : failed ? '异常' : '已停止';
  const proxyActionLabel = running ? '停止代理' : '启动代理';
  tray.setToolTip(`YouYu - ${statusLabel}`);
  trayMenu = Menu.buildFromTemplate([
    {
      label: `状态：${statusLabel}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: '打开窗口',
      click: showMainWindow
    },
    {
      label: proxyActionLabel,
      enabled: !trayBusy,
      click: () => {
        void runTrayAction(proxyActionLabel, async () => {
          return running ? stopProxy() : startProxy();
        });
      }
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: launchAtLogin,
      click: (menuItem) => {
        void toggleLaunchAtLogin(menuItem.checked);
      }
    },
    ...(petFeatureEnabled
      ? [
          {
            label: petVisibilityController.isUserRequestedVisible() ? '隐藏桌宠' : '显示桌宠',
            click: togglePetWindow
          }
        ]
      : []),
    {
      label: '网络修复',
      enabled: !trayBusy,
      click: () => {
        void runTrayAction('网络修复', async () => {
          return repairNetworkAndRestartApp();
        });
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      enabled: !trayBusy && !isUpdateInstallerHandoffPending(),
      click: () => {
        if (isUpdateInstallerHandoffPending()) {
          showMainWindow();
          return;
        }
        isQuitting = true;
        void cleanupBeforeExit();
      }
    }
  ]);
  tray.setContextMenu(trayMenu);
}

async function runTrayAction(label: string, action: () => Promise<AppSnapshot>) {
  if (trayBusy) return;
  trayBusy = true;
  refreshTrayMenu();
  syncPetStateToRuntime();
  try {
    const snapshot = await action();
    sendSnapshotToWindows(snapshot);
  } catch (error) {
    recordError(`${label}失败`, error);
    console.error(`${label} from tray failed`, error);
    await broadcastSnapshot().catch((broadcastError) => console.error('broadcast snapshot failed', broadcastError));
  } finally {
    trayBusy = false;
    refreshTrayMenu();
    syncPetStateToRuntime();
  }
}

function createTray() {
  if (tray || process.platform !== 'win32') return;

  tray = new Tray(trayIconPath);
  tray.setToolTip('YouYu');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  tray.on('right-click', refreshTrayMenu);
  refreshTrayMenu();
}

async function createWindow() {
  const display = screen.getPrimaryDisplay();
  const mainWindowMetrics = calculateMainWindowMetrics(display.size, display.workAreaSize);
  const win = new BrowserWindow({
    width: mainWindowMetrics.width,
    height: mainWindowMetrics.height,
    minWidth: mainWindowMetrics.minWidth,
    minHeight: mainWindowMetrics.minHeight,
    useContentSize: true,
    title: 'YouYu',
    icon: windowIconPath,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f5f0fb',
      symbolColor: '#4c3f5d',
      height: 30
    },
    show: false,
    skipTaskbar: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f0fb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: true
    }
  });
  mainWindow = win;
  win.webContents.setZoomFactor(mainWindowMetrics.zoomFactor);
  secureRendererNavigation(win);

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`preload failed: ${preloadPath}`, error);
  });

  win.once('ready-to-show', () => {
    if (!startHidden) {
      win.show();
      win.focus();
    }
  });

  win.on('close', (event) => {
    if (process.platform !== 'win32' || isQuitting || cleanupStarted) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function createPetWindow() {
  if (!petFeatureEnabled) return;
  if (petWindow) {
    showPetWindow();
    return;
  }

  const bounds = await getPetStartBounds();
  const win = new BrowserWindow({
    ...bounds,
    useContentSize: true,
    title: 'YouYu 桌宠',
    type: 'toolbar',
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: true
    }
  });
  petWindow = win;
  secureRendererNavigation(win);
  applyPetWindowTaskbarPolicy(win);
  win.setAlwaysOnTop(true, 'floating');
  setPetMousePassthrough(true, true);
  void startPetFullscreenProbe(win);

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`pet preload failed: ${preloadPath}`, error);
  });

  win.webContents.on('context-menu', () => {
    showPetContextMenu();
  });

  win.once('ready-to-show', () => {
    applyPetWindowVisibility();
    applyPetWindowTaskbarPolicy(win);
    sendPetState();
    syncPetStateToRuntime();
    refreshTrayMenu();
  });

  win.on('closed', () => {
    if (petWindow === win) {
      petWindow = null;
    }
    stopPetFullscreenProbe();
    stopPetDrag();
    clearPetDockBehavior();
    clearPetSequenceTimer();
    clearPetMoveTimer();
    refreshTrayMenu();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    url.searchParams.set('view', 'pet');
    await win.loadURL(url.toString());
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'pet' }
    });
  }
}

function secureRendererNavigation(window: BrowserWindow): void {
  const senderId = window.webContents.id;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.once('destroyed', () => {
    void ipcOperations.cancelSender(senderId);
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = window.webContents.getURL();
    if (!currentUrl) {
      event.preventDefault();
      return;
    }

    try {
      const current = new URL(currentUrl);
      const target = new URL(targetUrl);
      if (
        current.protocol === target.protocol &&
        current.origin === target.origin &&
        current.pathname === target.pathname
      ) {
        return;
      }
    } catch {
      // Invalid navigation targets are never allowed.
    }
    event.preventDefault();
  });
  window.webContents.on('will-redirect', (event) => event.preventDefault());
}

type ExitCleanupOptions = {
  relaunchArgs?: string[];
  throwOnFailure?: boolean;
};

async function cleanupBeforeExit(options: ExitCleanupOptions = {}): Promise<boolean> {
  if (isUpdateInstallerHandoffPending()) {
    isQuitting = false;
    showMainWindow();
    if (options.throwOnFailure) throw new Error('update installer launch pending');
    return false;
  }
  if (cleanupStarted) {
    if (options.throwOnFailure) throw new Error('application cleanup already in progress');
    return false;
  }
  const shouldRestoreRuntimeIntent = runtimeIntent.capture() !== undefined;
  cleanupStarted = true;
  isQuitting = true;
  runtimeIntent.cancel();
  lifecycle.suspendStarts();
  if (trafficSnapshotBroadcastTimer) {
    clearTimeout(trafficSnapshotBroadcastTimer);
    trafficSnapshotBroadcastTimer = undefined;
  }
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = undefined;
  }
  clearSubscriptionRefreshTimer();
  stopNodeHealthMonitor();
  clearRuntimeRecoveryTimer();
  activeNodeTestController?.abort();
  activeNodeTestController = undefined;
  stopRemoteConfigPolling();
  if (petFeatureEnabled) {
    stopPetFullscreenProbe({ restoreVisibility: false });
    stopPetDrag({ settle: false });
    clearPetDockBehavior();
    clearPetSequenceTimer();
    clearPetMoveTimer();
  }
  try {
    await trafficTracker.flush().catch((error) => appendLog(`流量统计失败: ${formatError(error)}`));
    await trafficReporter.reportPending().catch((error) => appendLog(`流量上报失败: ${formatError(error)}`));
    trafficTracker.stop();
    trafficReporter.stop();
    if (options.relaunchArgs) {
      await lifecycle.stop();
      app.relaunch({ args: options.relaunchArgs });
    } else {
      await lifecycle.shutdown();
    }
  } catch (error) {
    cleanupStarted = false;
    cleanupFinished = false;
    isQuitting = false;
    lifecycle.resumeStarts();
    recordError('退出清理失败', error);
    startRemoteConfigPolling();
    scheduleUpdateCheck(updatePeriodicIntervalMs);
    restartPetFullscreenProbe();
    if (shouldRestoreRuntimeIntent) {
      const restoredIntentGeneration = runtimeIntent.requestStart();
      if (lifecycle.getStatus() === 'stopped') {
        void startLifecycleWithRepairRetry(undefined, restoredIntentGeneration).catch((restartError) =>
          recordError('退出取消后的代理恢复失败', restartError)
        );
      } else {
        scheduleRuntimeRecovery(0);
      }
    }
    showMainWindow();
    if (options.throwOnFailure) throw error;
    return false;
  }
  cleanupFinished = true;
  app.exit(0);
  return true;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock || shutdownForInstall) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.includes('--shutdown-for-install')) {
      isQuitting = true;
      void cleanupBeforeExit();
      return;
    }
    showMainWindow();
  });

  app
    .whenReady()
    .then(async () => {
      try {
        app.configureHostResolver(createHostResolverOptions());
      } catch (error) {
        appendLog(`应用内 DNS 配置失败，继续使用系统解析: ${formatError(error)}`);
      }
      await prepareUpdateNetworkSession(electronSession.fromPartition(directNetworkPartition, { cache: false })).catch(
        (error) => appendLog(`后台直连会话初始化失败: ${formatError(error)}`)
      );
      await systemProxy.restore().catch((error) => appendLog(`恢复遗留系统代理失败: ${formatError(error)}`));
      await allocateRuntimePorts();
      registerIpc();
      setupAutoUpdates();
      await reconcileLaunchAtLogin();
      createTray();
      void createWindow().catch((error) => recordError('创建主窗口失败', error));
      startRemoteConfigPolling();
      void refreshTrafficTotalsFromServer();
      if (petFeatureEnabled) {
        void createPetWindow().catch((error) => recordError('创建桌宠窗口失败', error));
      }
      if (resumeProxyAfterRelaunch) {
        void startProxy()
          .then((snapshot) => sendSnapshotToWindows(snapshot))
          .catch((error) => recordError('重启后恢复代理失败', error));
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void createWindow().catch((error) => recordError('创建主窗口失败', error));
        }
      });
    })
    .catch((error) => {
      console.error('application initialization failed', error);
      isQuitting = true;
      app.quit();
    });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (isUpdateInstallerHandoffPending()) {
    event.preventDefault();
    isQuitting = false;
    showMainWindow();
    return;
  }
  if (updateInstallerLaunchPending && updateInstallerLaunchStarted) {
    updateInstallerBeforeQuitObserved = true;
  }
  if (updateInstallerLaunchFailed) {
    event.preventDefault();
    updateInstallerLaunchFailed = false;
    updateInstallerLaunchPending = false;
    cleanupFinished = false;
    isQuitting = false;
    showMainWindow();
    return;
  }
  isQuitting = true;
  if (!cleanupFinished) {
    event.preventDefault();
    if (!cleanupStarted) {
      void cleanupBeforeExit();
    }
  }
});
