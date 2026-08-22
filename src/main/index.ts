import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  Notification,
  session as electronSession,
  Tray,
  ipcMain as electronIpcMain,
  safeStorage,
  screen,
  type Rectangle,
  type SaveDialogOptions
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { CancellationError, CancellationToken } from 'builder-util-runtime';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile as writeTextFile } from 'node:fs/promises';
import { release as getOsRelease } from 'node:os';
import { createLifecycleController, type MihomoRuntime } from './lifecycle';
import { allocateDistinctRuntimePorts } from './runtimePorts';
import { createAppRuntimeActions } from './appRuntimeActions';
import { createAppRuntimeCoordinator } from './appRuntimeCoordinator';
import { IpcOperationRegistry } from './ipcOperations';
import { createTrustedIpcMain } from './trustedIpcMain';
import { LatestOperationCoordinator } from './latestOperationCoordinator';
import { NodeSelectionCoordinator } from './nodeSelectionCoordinator';
import { connectivityServices, probeProxyExitRegionCode, testAllConnectivity, testConnectivity } from './connectivity';
import { createMihomoApiClient, type NodeDelayProbeFailure } from './mihomo/api';
import {
  expectedExitRegionCode,
  isNodeInPreferredRegion,
  preferredRegionLabel,
  resolveNodeSelectionFallbackNotice,
  resolveNodeSelectionPolicy,
  type NodeSelectionPolicy
} from './mihomo/nodeSelectionPolicy';
import { createMihomoRuntime } from './mihomo/process';
import { createWindowsDeviceKeyProvider } from './platform/deviceKey';
import { createSystemProxyAdapter } from './platform/systemProxy';
import { runWindowsElevatedProcess, spawnWindowsElevatedMihomo } from './platform/elevatedProcess';
import { createWindowsStartupTask, StartupTaskWriteError } from './platform/startupTask';
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
  NodeHealthStore,
  type StoredNodeAvailability
} from './storage/nodeHealth';
import { createNodeHealthCoordinator, type NodeHealthContext } from './nodeHealthCoordinator';
import { createNodeSwitchCooldown } from './nodeSwitchCooldown';
import { resolveDefaultSubscriptionUrl } from './defaultSubscription';
import { formatReportedAppVersion, resolveAppVersion } from './appVersion';
import { TrafficReporter } from './traffic/reporter';
import { createTemporaryRuntimeLeaseManager, createTrafficRegistrationCoordinator } from './traffic/registration';
import { TrafficStore } from './traffic/store';
import { TrafficTracker } from './traffic/tracker';
import { RemoteConfigClient, type ActiveRemoteConfigSnapshot } from './remoteConfig';
import { syncRequiredBoundRemoteConfig } from './remoteConfigAuthority';
import { createRemoteSubscriptionCoordinator } from './remoteSubscription';
import { createSubscriptionCoordinator, type SubscriptionRefreshSource } from './subscriptionCoordinator';
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
import { createAppSnapshotReader } from './appSnapshot';
import { createAppWindowCoordinator } from './appWindowCoordinator';
import {
  ipcChannels,
  toDesktopNoticeSnapshot,
  type AppUpdateSnapshot,
  type AppSnapshot,
  type CurrentNodeHealth,
  type DesktopPetState,
  type DiagnosticIssueKind,
  type OperationRequest,
  type ProxyNode,
  type RemoteControlConfig,
  type StrategyKey
} from '../shared/ipc';
import { isExpectedOperationCancellation } from '../shared/operationCancellation';
import { updateInstallingMessage } from '../shared/updateProgress';
import { deferUpdateInstallerLaunch } from './updateInstallHandoff';
import { launchDownloadedUpdateInstaller, resolveDownloadedUpdateInstallerPath } from './updateInstallerLauncher';
import {
  resolveUpdateRelaunchAcknowledgementRequest,
  writeUpdateRelaunchAcknowledgement
} from './updateRelaunchAcknowledgement';
import { createCodexConnectionRecoveryCoordinator } from './codexConnectionRecovery';
import { createPetVisibilityController } from './petVisibilityController';
import { applyPetWindowTaskbarPolicy } from './petWindowPolicy';
import { createRuntimeIntentController } from './runtimeIntent';
import { runProxyStartSequence } from './proxyStart';
import { classifyUpdateInstallFailure } from '../shared/userFacingCopy';
import {
  buildProxyRelaunchArguments,
  resumeProxyAfterRelaunchArgument,
  shouldReportRecoveredUpdateInstallFailure,
  updateInstallFailedRelaunchArgument,
  updatedRelaunchArgument
} from './appRelaunch';
import { clearMihomoRepairCache, runNetworkRepair, type NetworkRepairOptions } from './networkRepair';
import {
  DiagnosticLogBuffer,
  LocalDiagnosticSession,
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
  runUpdateDownloadWithNetworkFallback,
  type UpdateNetworkRoute
} from './updateNetwork';
import { createUpdateCoordinator } from './updateCoordinator';
import {
  createUpdateDownloadHealthMonitor,
  UpdateRouteHealthError,
  type UpdateDownloadHealthReason
} from './updateDownloadHealth';
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
const recoveredFromUpdateInstallFailure = process.argv.includes(updateInstallFailedRelaunchArgument);
const launchedAfterSuccessfulUpdate = process.argv.includes(updatedRelaunchArgument);
const startupUpdateRelaunchAcknowledgement = resolveUpdateRelaunchAcknowledgementRequest(process.argv);
const windowsStartupTask = createWindowsStartupTask({ executablePath: process.execPath });
let mainWindow: BrowserWindow | null = null;
let applicationInitializationReady = false;
let updateRelaunchResumeRequested = resumeProxyAfterRelaunch;
let updateRelaunchResumeStarted = false;
let recoveredUpdateInstallFailureReported = false;
let petWindow: BrowserWindow | null = null;
let noticeWindow: BrowserWindow | null = null;
const ipcMain = createTrustedIpcMain({
  ipcMain: electronIpcMain,
  getMainWebContents: () => mainWindow?.webContents,
  getNoticeWebContents: () => noticeWindow?.webContents,
  getPetWebContents: () => petWindow?.webContents,
  isDev,
  rendererUrl: process.env.ELECTRON_RENDERER_URL
});
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
const nodeTestOperations = new LatestOperationCoordinator<AppSnapshot>();
const nodeSelectionCoordinator = new NodeSelectionCoordinator();
let subscriptionRevision = 0;
const ipcOperations = new IpcOperationRegistry((error) => appendLog(`取消操作清理失败: ${formatError(error)}`));
const runtimeIntent = createRuntimeIntentController();
let lastError: string | undefined;
let preferredAutoNodeRefineController: AbortController | undefined;
let nodeSelectionNotice: AppSnapshot['nodeSelectionNotice'];
const appLogs = new DiagnosticLogBuffer();
let localDiagnosticSession: LocalDiagnosticSession | undefined;
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
const noticeWindowSize = {
  width: 336,
  height: 188
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
const nodeHealthRetryDelayMs = 15000;
const nodeHealthFailureThreshold = 3;
const nodeHealthProbeTimeoutMs = 4000;
const nodeSwitchCooldownMs = 15 * 60 * 1000;
const nodeSwitchCooldown = createNodeSwitchCooldown({ cooldownMs: nodeSwitchCooldownMs });
const remoteConfigSyncIntervalMs = 3 * 60 * 1000;
const remoteConfigWakeCooldownMs = 12 * 1000;
const updatePeriodicIntervalMs = 30 * 60 * 1000;
const trafficSnapshotBroadcastIntervalMs = 10000;
const runtimeRecoveryInitialDelayMs = 1500;

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
const reportedAppVersion = formatReportedAppVersion(appVersion, appBuildChannel);
let downloadedUpdateInstallerPaths: string[] = [];
updateSnapshot = {
  currentVersion: appVersion,
  buildChannel: appBuildChannel,
  updateChannel: appUpdateChannel,
  status: 'idle'
};
const updateCoordinator = createUpdateCoordinator({
  updater: autoUpdater,
  currentVersion: appVersion,
  buildChannel: appBuildChannel,
  updateChannel: appUpdateChannel,
  isPackaged: () => app.isPackaged,
  periodicIntervalMs: updatePeriodicIntervalMs,
  executeCheck: () =>
    runUpdateCheckWithNetworkFallback({
      session: autoUpdater.netSession,
      check: () => autoUpdater.checkForUpdates(),
      getProxyUrl: getRuntimeTrafficProxyUrl,
      onRetry: (route, detail) => logUpdateNetworkRetry('check', route, detail)
    }),
  executeDownload: async () => {
    const downloadedPaths = await runUpdateDownloadWithNetworkFallback({
      session: autoUpdater.netSession,
      download: ({ route, attempt }) => downloadUpdateWithHealthMonitor(route, attempt),
      getProxyUrl: getRuntimeTrafficProxyUrl,
      onRetry: (route, detail) => logUpdateNetworkRetry('download', route, detail)
    });
    downloadedUpdateInstallerPaths = downloadedPaths;
    return downloadedPaths;
  },
  formatError,
  onLog: appendLog,
  onSnapshot: (next) => {
    updateSnapshot = next;
    void broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
  },
  isInstallerLaunchPending: () => updateInstallerLaunchPending,
  onInstallerError: recoverFromUpdateInstallerLaunchFailure
});
const settingsStore = new SettingsStore(app.getPath('userData'), {
  defaultSubscriptionUrl: readDefaultSubscriptionUrl(defaultSubscriptionPath)
});
const trafficStore = new TrafficStore(app.getPath('userData'), { secretStorage: safeStorage });
const deviceKeyProvider = createWindowsDeviceKeyProvider();
const nodeHealthStore = new NodeHealthStore(app.getPath('userData'));
const remoteConfigClient = new RemoteConfigClient({
  baseDir: app.getPath('userData'),
  endpoint: readOptionalText(trafficApiUrlPath),
  appVersion: reportedAppVersion,
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
  }
});
const trafficReporter = new TrafficReporter({
  store: trafficStore,
  endpoint: readOptionalText(trafficApiUrlPath),
  appVersion: reportedAppVersion,
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
const codexConnectionRecovery = createCodexConnectionRecoveryCoordinator({
  createMihomoApi: async () => {
    const settings = await settingsStore.read();
    return createRuntimeMihomoApi({ secret: settings.controllerSecret });
  },
  readConnections: async () => {
    if (lifecycle.getStatus() !== 'running') return [];
    const settings = await settingsStore.read();
    const stats = await createRuntimeMihomoApi({ secret: settings.controllerSecret }).getRuntimeStats({
      includeConnections: true
    });
    return stats.connections ?? [];
  }
});
const trafficTracker = new TrafficTracker({
  store: trafficStore,
  intervalMs: 5000,
  isRunning: () => lifecycle.getStatus() === 'running',
  readRuntimeStats: async () => {
    const settings = await settingsStore.read();
    const stats = await createRuntimeMihomoApi({ secret: settings.controllerSecret }).getRuntimeStats({
      includeConnections: true
    });
    void codexConnectionRecovery.observe(stats.connections ?? []).catch(() => undefined);
    return stats;
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
          appRuntimeCoordinator.scheduleRecovery(runtimeRecoveryInitialDelayMs);
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
  try {
    localDiagnosticSession?.append(message);
  } catch {
    localDiagnosticSession = undefined;
  }
}

function initializeLocalDiagnostics(): void {
  try {
    const session = new LocalDiagnosticSession(join(app.getPath('userData'), 'diagnostics'));
    localDiagnosticSession = session;
    if (!session.recovery.unexpectedExit) return;
    for (const entry of session.recovery.logs) appLogs.append(entry.message, entry.at);
    appLogs.append('已恢复上次异常结束前的诊断记录');
  } catch (error) {
    appLogs.append(`本地诊断初始化失败: ${formatError(error)}`);
  }
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
  const logs = appLogs.getExportLogs();

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

async function downloadUpdateWithHealthMonitor(route: UpdateNetworkRoute, attempt: 1 | 2): Promise<string[]> {
  const cancellationToken = new CancellationToken();
  let unhealthyReason: UpdateDownloadHealthReason | undefined;
  const monitor = createUpdateDownloadHealthMonitor({
    source: autoUpdater,
    route,
    getProxyUrl: () => (attempt === 1 ? getRuntimeTrafficProxyUrl() : undefined),
    cancel: () => cancellationToken.cancel(),
    onUnhealthy: (reason) => {
      unhealthyReason = reason;
    }
  });

  try {
    return await autoUpdater.downloadUpdate(cancellationToken);
  } catch (error) {
    if (unhealthyReason && cancellationToken.cancelled && error instanceof CancellationError) {
      throw new UpdateRouteHealthError(unhealthyReason, error);
    }
    throw error;
  } finally {
    monitor.dispose();
    cancellationToken.dispose();
  }
}

function logUpdateNetworkRetry(context: 'check' | 'download', route: UpdateNetworkRoute, detail: string): void {
  const routeLabel = route === 'local-proxy' ? '本地代理' : '直连';
  appendLog(`${context === 'download' ? '更新下载' : '检查更新'}网络异常，已切换至${routeLabel}重试: ${detail}`);
  if (context === 'download') {
    updateCoordinator.reportNetworkRetry('线路不稳定，已自动切换重试');
  }
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

type RemoteConfigSyncOptions = {
  proxyUrl?: string;
  restartIfRunning?: boolean;
  throwOnError?: boolean;
  quiet?: boolean;
  signal?: AbortSignal;
  intentGeneration?: number;
  source?: SubscriptionRefreshSource;
};

type RemoteConfigSyncRequest = Omit<RemoteConfigSyncOptions, 'signal' | 'source'>;
type RemoteConfigSyncExecutionOptions = RemoteConfigSyncRequest & { signal?: AbortSignal };

async function performRemoteConfigSync(options: RemoteConfigSyncExecutionOptions = {}): Promise<boolean> {
  let subscriptionChanged = false;
  let clientStateChanged = false;
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
      await restartLifecycleForIntent(options.intentGeneration);
    }
  };

  try {
    throwIfAborted(options.signal);
    const cachedSnapshot = await remoteConfigClient.getActiveConfigSnapshot();
    subscriptionChanged = await applyRemoteSubscription(cachedSnapshot.config, cachedSnapshot);
    throwIfAborted(options.signal);
    const result = await remoteConfigClient.sync({ proxyUrl: options.proxyUrl, signal: options.signal });
    clientStateChanged = Boolean(result.profileChanged || result.noticeChanged);
    if (clientStateChanged) {
      appendLog('remote user state updated');
      await broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
    }
    throwIfAborted(options.signal);
    const syncedSnapshot = await remoteConfigClient.getActiveConfigSnapshot();
    subscriptionChanged = (await applyRemoteSubscription(syncedSnapshot.config, syncedSnapshot)) || subscriptionChanged;
    throwIfAborted(options.signal);
    if (!result.changed && !subscriptionChanged) return clientStateChanged;

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
    const expectedCancellation = isExpectedOperationCancellation(reportedError);
    const recoverable = expectedCancellation || isRecoverableSyncError(reportedError);
    if (!expectedCancellation && (!recoverable || (!options.quiet && options.throwOnError))) {
      appendLog(`remote config sync failed: ${formatError(reportedError)}`);
    }
    if (options.throwOnError) throw reportedError;
    return subscriptionChanged || clientStateChanged;
  }
}

async function syncRemoteConfig(options: RemoteConfigSyncOptions = {}): Promise<boolean> {
  const { source = 'system', signal, ...request } = options;
  const result = await subscriptionCoordinator.refresh('remote', { source, signal, request });
  return result.applied ? Boolean(result.value) : false;
}

let lastRemoteConfigWakeAt = 0;
function wakeRemoteConfig(): void {
  if (cleanupStarted || cleanupFinished || isQuitting) return;
  const now = Date.now();
  if (now - lastRemoteConfigWakeAt < remoteConfigWakeCooldownMs) return;
  lastRemoteConfigWakeAt = now;
  void syncRemoteConfig({
    proxyUrl: getRuntimeTrafficProxyUrl(),
    restartIfRunning: true,
    quiet: true,
    intentGeneration: runtimeIntent.capture(),
    source: 'system'
  }).catch(() => undefined);
}

function startRemoteConfigPolling() {
  void subscriptionCoordinator.start().catch((error) => recordError('后台刷新计划启动失败', error));
}

function stopRemoteConfigPolling() {
  subscriptionCoordinator.stop();
}

async function applyRemoteSubscription(
  config?: RemoteControlConfig,
  snapshot?: ActiveRemoteConfigSnapshot
): Promise<boolean> {
  return remoteSubscriptionCoordinator.apply(config, snapshot);
}

function isRecoverableSyncError(error: unknown): boolean {
  if (isExpectedOperationCancellation(error)) return true;
  const message = formatError(error);
  return [
    'fetch failed',
    'Failed to fetch',
    'request timed out',
    'proxy connect timed out',
    'timed out',
    'aborted',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'REQUEST_FAILED',
    'FETCH_FAILED',
    'TIMEOUT'
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
  autoUpdater.autoDownload = false;
  // The per-machine NSIS installer crosses UAC. It must be started only by the
  // controlled handoff below, which supplies its authenticated CLI bridge.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL(createUpdateFeedConfig());
  autoUpdater.channel = appUpdateChannel;
  autoUpdater.allowDowngrade = false;
  updateCoordinator.start();
}

function setUpdateSnapshot(next: Partial<AppUpdateSnapshot>) {
  updateCoordinator.setSnapshot(next);
}

function scheduleUpdateCheck(delayMs = updatePeriodicIntervalMs) {
  updateCoordinator.schedule(delayMs);
}

async function checkForUpdatesNow(userInitiated = true): Promise<AppSnapshot> {
  await updateCoordinator.check(userInitiated);
  return createSnapshot();
}

async function installDownloadedUpdate(): Promise<AppSnapshot> {
  if (updateSnapshot.status !== 'downloaded' || updateInstallerLaunchPending) {
    throw new Error('update not downloaded');
  }

  const preparation = await updateCoordinator.prepareInstall();
  if (!preparation.ready) return createSnapshot();
  if (updateSnapshot.status !== 'downloaded' || updateInstallerLaunchPending) {
    throw new Error('update not downloaded');
  }

  const installerPath = resolveDownloadedUpdateInstallerPath({
    downloadedPaths: downloadedUpdateInstallerPaths,
    updaterInstallerPath: getAutoUpdaterInstallerPath()
  });
  const expectedVersion = preparation.snapshot.downloadedVersion;
  if (!expectedVersion) throw new Error('downloaded update version is unavailable');

  updateInstallerLaunchPending = true;
  updateInstallerLaunchFailed = false;
  updateInstallerLaunchStarted = false;
  updateInstallerBeforeQuitObserved = false;
  updateInstallRuntimeWasRunning = lifecycle.getStatus() === 'running';
  const shouldResumeProxyAfterUpdate = updateInstallRuntimeWasRunning;
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
      launch: async (handoff) => {
        if (!updateInstallerLaunchPending || updateInstallAttempt !== installAttempt) {
          return;
        }
        await launchDownloadedUpdateInstaller({
          installerPath,
          expectedVersion,
          resumeProxyAfterRelaunch: shouldResumeProxyAfterUpdate,
          handoff
        });
        if (!updateInstallerLaunchPending || updateInstallAttempt !== installAttempt) {
          throw new Error('update installer launch was canceled');
        }
        updateInstallerLaunchStarted = true;
        cleanupFinished = true;
        isQuitting = true;
        app.quit();
      },
      onError: recoverFromUpdateInstallerLaunchFailure,
      isCurrent: () => updateInstallerLaunchPending && updateInstallAttempt === installAttempt
    });
    return snapshot;
  } catch (error) {
    if (installAttempt === updateInstallAttempt && updateInstallerLaunchPending) {
      recoverFromUpdateInstallFailure('准备安装失败', error);
    }
    throw error;
  }
}

function getAutoUpdaterInstallerPath(): unknown {
  try {
    return Reflect.get(autoUpdater as object, 'installerPath');
  } catch {
    return undefined;
  }
}

function recoverFromUpdateInstallerLaunchFailure(error: unknown) {
  recoverFromUpdateInstallFailure('启动安装器失败', error);
}

async function syncRequiredRemoteConfig(options: RemoteConfigSyncOptions = {}): Promise<boolean> {
  return syncRequiredBoundRemoteConfig({
    sync: () => syncRemoteConfig({ ...options, throwOnError: false }),
    readSnapshot: () => remoteConfigClient.getActiveConfigSnapshot()
  });
}

function reportRecoveredUpdateInstallFailure() {
  if (recoveredUpdateInstallFailureReported) return;
  recoveredUpdateInstallFailureReported = true;
  const message = '更新安装未完成，已重新打开当前版本，请重新检查并安装';
  appendLog(message);
  setUpdateSnapshot({ status: 'failed', message });
  refreshTrayMenu();
  void broadcastSnapshot().catch((error) => recordError('更新失败状态通知失败', error));
}

function resumeProxyFromRelaunch() {
  updateRelaunchResumeRequested = true;
  if (!applicationInitializationReady || updateRelaunchResumeStarted) return;
  updateRelaunchResumeStarted = true;
  void startProxy()
    .then((snapshot) => sendSnapshotToWindows(snapshot))
    .catch((error) => recordError('重启后恢复代理失败', error));
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
  setUpdateSnapshot({
    status: 'downloaded',
    message,
    failureKind: classifyUpdateInstallFailure(error)
  });
  refreshTrayMenu();
  startRemoteConfigPolling();
  if (shouldRestartRuntime && restartIntentGeneration !== undefined) {
    void startLifecycleWithSafeRetry(undefined, restartIntentGeneration)
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

async function allocateRuntimePorts() {
  const { mixedPort, controllerPort, dnsPort } = await allocateDistinctRuntimePorts();
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
      appRuntimeCoordinator.clearRecoveryTimer();
      startNodeHealthMonitor();
    } else {
      codexConnectionRecovery.reset();
      trafficTracker.stop();
      trafficReporter.stop();
      stopNodeHealthMonitor();
    }
    if (status === 'stopped') {
      appRuntimeCoordinator.clearRecoveryTimer();
    }
    refreshTrayMenu();
    syncPetStateToRuntime();
    scheduleSubscriptionRefresh();
  }
});

const appRuntimeActions = createAppRuntimeActions({
  start: (signal) => lifecycle.start(signal),
  restart: (signal) => lifecycle.restart(signal),
  throwIfNetworkRepairInProgress,
  throwIfRuntimeIntentCanceled,
  appendLog,
  formatError
});

const appRuntimeCoordinator = createAppRuntimeCoordinator<AppSnapshot, AppSnapshot, void, AppSnapshot | undefined>({
  getStatus: () => lifecycle.getStatus(),
  start: ({ signal }) => performStartProxy(signal),
  stop: ({ signal }) => performStopProxy(signal),
  restart: ({ signal }) => performRestartLifecycleForUser(signal),
  recover: ({ signal }) => performRuntimeRecovery(signal),
  canRecover: () =>
    !networkRepairInProgress &&
    !isQuitting &&
    !cleanupStarted &&
    !cleanupFinished &&
    runtimeIntent.capture() !== undefined &&
    lifecycle.getStatus() !== 'stopped',
  onOperationChange: refreshTrayMenu,
  onBackgroundError(error) {
    if (isExpectedAppRuntimeCancellation(error)) return;
    recordError('自动恢复失败', error);
    void broadcastSnapshot().catch((broadcastError) => console.error('broadcast snapshot failed', broadcastError));
    refreshTrayMenu();
  }
});

const temporaryRegistrationRuntime = createTemporaryRuntimeLeaseManager({
  isRuntimeRunning: () => lifecycle.getStatus() === 'running',
  captureRuntimeIntent: () => runtimeIntent.capture(),
  startRuntime: (intentGeneration) => startLifecycleWithSafeRetry(undefined, intentGeneration),
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
  restart: () => restartLifecycleForUser()
};

type SubscriptionRefreshOutcome = {
  performed: boolean;
  lastErrorBeforeRefresh?: string;
  issueBeforeRefresh?: DiagnosticIssueKind;
};

const subscriptionCoordinator = createSubscriptionCoordinator<
  RemoteConfigSyncRequest,
  void,
  boolean,
  SubscriptionRefreshOutcome
>({
  async readSnapshot() {
    const [settings, remoteSnapshot] = await Promise.all([
      settingsStore.read(),
      remoteConfigClient.getActiveConfigSnapshot()
    ]);
    const backgroundWorkEnabled = !networkRepairInProgress && !cleanupStarted && !cleanupFinished && !isQuitting;
    return {
      subscriptionUrl: settings.subscriptionUrl,
      subscriptionRevision,
      remoteRevision: JSON.stringify([remoteSnapshot.binding ?? null, remoteSnapshot.revision]),
      subscriptionIntervalMs: settings.subscriptionRefreshIntervalHours * 60 * 60 * 1000,
      remoteIntervalMs: remoteConfigSyncIntervalMs,
      subscriptionEnabled:
        backgroundWorkEnabled &&
        lifecycle.getStatus() === 'running' &&
        Boolean(settings.subscriptionUrl.trim()) &&
        settings.subscriptionRefreshIntervalHours > 0,
      remoteEnabled: backgroundWorkEnabled
    };
  },
  refreshRemote: ({ request, signal }) =>
    performRemoteConfigSync({
      proxyUrl: getRuntimeTrafficProxyUrl(),
      restartIfRunning: true,
      quiet: true,
      intentGeneration: runtimeIntent.capture(),
      ...request,
      signal
    }),
  async refreshSubscription({ source, signal }) {
    const lastErrorBeforeRefresh = lastError;
    const issueBeforeRefresh = classifyDiagnosticIssue(lastErrorBeforeRefresh);
    if (source === 'background') {
      if (networkRepairInProgress || lifecycle.getStatus() !== 'running') {
        return { performed: false, lastErrorBeforeRefresh, issueBeforeRefresh };
      }
      const intentGeneration = runtimeIntent.capture();
      if (intentGeneration === undefined) {
        return { performed: false, lastErrorBeforeRefresh, issueBeforeRefresh };
      }
      appendLog('后台刷新订阅');
      await updateSubscriptionNodes(
        {
          settingsStore,
          lifecycle,
          runtime: runtimeActionsForIntent(intentGeneration),
          createMihomoApi: createRuntimeMihomoApi,
          createSnapshot
        },
        { signal }
      );
      const refreshedSettings = await settingsStore.read();
      if (lifecycle.getStatus() === 'running' && refreshedSettings.strategy === 'auto') {
        await selectPreferredAutoNode({ signal });
      }
      return { performed: true, lastErrorBeforeRefresh, issueBeforeRefresh };
    }

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
    const refreshedSettings = await settingsStore.read();
    if (lifecycle.getStatus() === 'running' && refreshedSettings.strategy === 'auto') {
      await selectPreferredAutoNode({ signal });
    }
    return { performed: true };
  },
  async onSubscriptionSuccess(result, context) {
    if (!result.performed) return;
    context.signal.throwIfAborted();
    subscriptionRevision += 1;
    if (context.source !== 'background') return;
    const nextSnapshot = await createSnapshot();
    context.signal.throwIfAborted();
    if (isDiagnosticIssueResolvedByOperation('subscription-refresh', result.issueBeforeRefresh)) {
      clearLastErrorIfUnchanged(result.lastErrorBeforeRefresh);
    }
    sendSnapshotToWindows(nextSnapshot);
    refreshTrayMenu();
  },
  async onBackgroundError(kind, error) {
    if (kind !== 'subscription') return;
    if (isExpectedOperationCancellation(error)) return;
    recordError('后台刷新订阅失败', error);
    await broadcastSnapshot().catch((broadcastError) => console.error('broadcast snapshot failed', broadcastError));
    refreshTrayMenu();
  }
});

function scheduleSubscriptionRefresh() {
  void subscriptionCoordinator.reschedule().catch((error) => recordError('订阅刷新计划失败', error));
}

function startNodeHealthMonitor() {
  nodeHealthCoordinator.start();
}

function stopNodeHealthMonitor() {
  nodeHealthCoordinator.stop();
}

function isProxyNodeName(nodeName: string): boolean {
  return Boolean(nodeName) && nodeName !== 'DIRECT';
}

type RuntimeNodeHealthContext = NodeHealthContext & {
  settings: Awaited<ReturnType<typeof settingsStore.read>>;
};

function createRuntimeNodeHealthContext(
  settings: Awaited<ReturnType<typeof settingsStore.read>>,
  nodeName: string,
  running: boolean
): RuntimeNodeHealthContext {
  return {
    settings,
    nodeName,
    running,
    direct: settings.mode === 'direct' || settings.strategy === 'direct',
    revision: JSON.stringify([
      settings.mode,
      settings.strategy,
      settings.selectedNode,
      settings.subscriptionUrl,
      settings.controllerSecret,
      subscriptionRevision
    ])
  };
}

async function readRuntimeNodeHealthContext(): Promise<RuntimeNodeHealthContext> {
  const settings = await settingsStore.read();
  const running = lifecycle.getStatus() === 'running';
  const nodeName = running ? await createRuntimeMihomoApi({ secret: settings.controllerSecret }).getCurrentNode() : '';
  return createRuntimeNodeHealthContext(settings, nodeName, running && lifecycle.getStatus() === 'running');
}

let pendingNodeProbeFailure: { nodeName: string; failure: NodeDelayProbeFailure } | undefined;

function flushNodeProbeFailure(nodeName: string): void {
  if (pendingNodeProbeFailure?.nodeName !== nodeName) return;
  appendLog(`[node-probe] ${JSON.stringify({ node: nodeName, checks: pendingNodeProbeFailure.failure.checks })}`);
  pendingNodeProbeFailure = undefined;
}

const nodeHealthCoordinator = createNodeHealthCoordinator<RuntimeNodeHealthContext, StoredNodeAvailability>({
  totalAvailabilityCount: connectivityServices.length,
  initialDelayMs: nodeHealthInitialDelayMs,
  intervalMs: nodeHealthIntervalMs,
  retryDelayMs: nodeHealthRetryDelayMs,
  failureThreshold: nodeHealthFailureThreshold,
  readContext: readRuntimeNodeHealthContext,
  async probeDelay(context, signal) {
    pendingNodeProbeFailure = undefined;
    try {
      const delay = await createRuntimeMihomoApi({ secret: context.settings.controllerSecret }).testNodeDelay(
        context.nodeName,
        {
          signal,
          timeoutMs: nodeHealthProbeTimeoutMs,
          onFailure: (failure) => {
            pendingNodeProbeFailure = { nodeName: context.nodeName, failure };
          }
        }
      );
      if (typeof delay === 'number') pendingNodeProbeFailure = undefined;
      return delay;
    } catch {
      signal.throwIfAborted();
      pendingNodeProbeFailure = undefined;
      return undefined;
    }
  },
  async recoverNode(context, signal) {
    return nodeSelectionCoordinator.coalesceAutomatic(signal, async (operationSignal) => {
      const mihomoApi = createRuntimeMihomoApi({ secret: context.settings.controllerSecret });
      const avoidNodes = nodeSwitchCooldown.avoidWith(context.nodeName);
      const selectedNode = isAutomaticStrategy(context.settings.strategy)
        ? context.settings.strategy === 'auto'
          ? await performPreferredAutoNode({
              avoidNodes,
              allowAvoidFallback: false,
              signal: operationSignal
            }).catch((error) => {
              operationSignal.throwIfAborted();
              appendLog(`自动地区节点恢复失败: ${formatError(error)}`);
              return undefined;
            })
          : await mihomoApi.selectBestUsableNodeForStrategy(context.settings.strategy, {
              avoidNodes,
              allowAvoidFallback: false,
              signal: operationSignal
            })
        : await mihomoApi.selectBestUsableNode({
            avoidNodes,
            allowAvoidFallback: false,
            signal: operationSignal
          });
      operationSignal.throwIfAborted();
      if (!selectedNode) return undefined;
      nodeSwitchCooldown.remember(context.nodeName);
      await settingsStore.update(
        isAutomaticStrategy(context.settings.strategy)
          ? { strategy: context.settings.strategy, selectedNode: null }
          : { strategy: 'manual', selectedNode }
      );
      operationSignal.throwIfAborted();
      await mihomoApi.closeConnections().catch((error) => appendLog(`关闭旧连接失败: ${formatError(error)}`));
      operationSignal.throwIfAborted();
      await mihomoApi.flushDnsCache().catch((error) => appendLog(`刷新 DNS 缓存失败: ${formatError(error)}`));
      operationSignal.throwIfAborted();
      return selectedNode;
    });
  },
  onTransientFailure: (nodeName) => {
    flushNodeProbeFailure(nodeName);
    appendLog(`当前节点短暂异常，等待复查: ${nodeName}`);
  },
  onRecovering: (nodeName) => {
    flushNodeProbeFailure(nodeName);
    appendLog(`当前节点不可用，正在切换: ${nodeName}`);
  },
  onRecoverySkipped: (nodeName) => {
    appendLog(`当前节点探测未通过，暂时没有更好的候选节点，先继续使用: ${nodeName}`);
  },
  async onRecovered(nodeName, signal) {
    signal.throwIfAborted();
    appendLog(`已切换可用节点: ${nodeName}`);
    const nextSnapshot = await createSnapshot();
    signal.throwIfAborted();
    sendSnapshotToWindows(nextSnapshot);
  },
  async onBackgroundError(error) {
    if (isExpectedOperationCancellation(error)) return;
    appendLog(`节点检查失败: ${formatError(error)}`);
    appRuntimeCoordinator.scheduleRecovery(nodeHealthRepairDelayMs);
  },
  readCachedAvailability: (nodeName) => nodeHealthStore.getTodayAvailability(nodeName),
  async probeAvailability(_context, signal) {
    signal.throwIfAborted();
    const results = await testAllConnectivity(
      {
        getMixedPort: () => runtimePorts.mixedPort,
        getControllerPort: () => runtimePorts.controllerPort,
        getControllerSecret: async () => (await settingsStore.read()).controllerSecret,
        isRunning: () => lifecycle.getStatus() === 'running'
      },
      { signal }
    );
    signal.throwIfAborted();
    return createAvailabilityRecord(_context.nodeName, results);
  },
  async saveAvailability(record, operation) {
    operation.signal.throwIfAborted();
    if (!operation.isCurrent()) return false;
    await nodeHealthStore.saveAvailability(record);
    operation.signal.throwIfAborted();
    return operation.isCurrent();
  },
  toAvailabilitySnapshot: availabilitySnapshotFromRecord,
  onAvailabilityError: (error) => appendLog(`节点可用度测试失败: ${formatError(error)}`),
  onHealthChanged: () => {
    void broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
  }
});

async function updateCurrentNodeDelayFromManualTest(
  nodeName: string,
  delay: number | undefined,
  testState?: ProxyNode['testState']
): Promise<void> {
  if (!isProxyNodeName(nodeName) || lifecycle.getStatus() !== 'running') return;
  await nodeHealthCoordinator.recordManualDelay(nodeName, delay, testState).catch((error) => {
    if (lifecycle.getStatus() === 'running') throw error;
  });
}

async function getCurrentNodeHealthSnapshot(
  nodeName: string,
  running: boolean,
  settings: Awaited<ReturnType<typeof settingsStore.read>>
): Promise<CurrentNodeHealth> {
  return nodeHealthCoordinator.getSnapshot(createRuntimeNodeHealthContext(settings, nodeName, running));
}

function scheduleNodeHealthCheck(delayMs = nodeHealthIntervalMs) {
  nodeHealthCoordinator.reschedule(delayMs);
}

async function performRuntimeRecovery(signal: AbortSignal): Promise<AppSnapshot | undefined> {
  const intentGeneration = runtimeIntent.capture();
  if (intentGeneration === undefined) return;
  signal.throwIfAborted();
  if (networkRepairInProgress || isQuitting || cleanupStarted || cleanupFinished) return;
  if (lifecycle.getStatus() === 'stopped') return;

  appendLog('检测到代理异常，正在尝试安全恢复');
  throwIfRuntimeIntentCanceled(intentGeneration);
  const snapshot = await performStartProxy(signal, intentGeneration);
  signal.throwIfAborted();
  throwIfRuntimeIntentCanceled(intentGeneration);
  sendSnapshotToWindows(snapshot);
  refreshTrayMenu();
  return snapshot;
}

function isExpectedAppRuntimeCancellation(error: unknown): boolean {
  return isExpectedOperationCancellation(error);
}

function isAutomaticStrategy(strategy: StrategyKey): strategy is Exclude<StrategyKey, 'manual' | 'direct'> {
  return strategy === 'auto' || strategy === 'fallback' || strategy === 'load-balance';
}

const appSnapshotReader = createAppSnapshotReader({
  readSettings: () => settingsStore.read(),
  getRuntimeStatus: () => lifecycle.getStatus(),
  getControllerPort: () => runtimePorts.controllerPort,
  createMihomoApi: createMihomoApiClient,
  readTrafficSnapshot: () => trafficStore.getSnapshot(),
  readUserNotice: () => remoteConfigClient.getActiveNotice(),
  readRemoteConfigSnapshot: () => remoteConfigClient.getActiveConfigSnapshot(),
  readNodeHealth: getCurrentNodeHealthSnapshot,
  readDynamicState: () => ({
    nodeSelectionNotice,
    subscriptionRevision,
    update: updateSnapshot,
    lastError,
    logs: appLogs.getLogs(diagnosticSnapshotLogLimit),
    logCount: appLogs.size,
    logCapacity: appLogs.capacity,
    droppedLogCount: appLogs.droppedCount
  }),
  classifyDiagnosticIssue
});

function createSnapshot(): Promise<AppSnapshot> {
  return appSnapshotReader.read();
}

const appWindowCoordinator = createAppWindowCoordinator({
  getMainWindow: () => mainWindow,
  getNoticeWindow: () => noticeWindow,
  getPetWindow: () => petWindow,
  createNoticeWindow,
  isPetFeatureEnabled: () => petFeatureEnabled,
  isPetFullscreenSuppressed: () => petVisibilityController.isFullscreenSuppressed(),
  isCleanupStarted: () => cleanupStarted,
  isQuitting: () => isQuitting,
  screen,
  noticeWindowSize,
  onNoticeExpired: async () => {
    await broadcastSnapshot();
  },
  onError: (context, error) => {
    const message = context === 'expiry' ? 'notice expiry snapshot failed' : 'notice window synchronization failed';
    console.error(message, error);
  }
});

function sendSnapshotToWindows(snapshot: AppSnapshot): void {
  appWindowCoordinator.send(snapshot);
}

function scheduleNoticeLayout(snapshot?: AppSnapshot): void {
  appWindowCoordinator.schedule(snapshot);
}

function syncNoticeWindow(): Promise<void> {
  return appWindowCoordinator.sync();
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

function createRuntimeMihomoApi(options: { secret: string }) {
  return createMihomoApiClient({
    ...options,
    controllerPort: runtimePorts.controllerPort
  });
}

async function readNodeSelectionPolicy(): Promise<NodeSelectionPolicy> {
  return resolveNodeSelectionPolicy(await remoteConfigClient.getActiveConfig());
}

function publishNodeSelectionNotice(message: string): void {
  nodeSelectionNotice = { id: Date.now(), message };
  appendLog(message);
  if (!mainWindow?.isVisible() && Notification.isSupported()) {
    new Notification({ title: 'YouYu 节点切换', body: message }).show();
  }
}

function selectPreferredAutoNode(
  options: {
    signal?: AbortSignal;
    avoidNode?: string;
    avoidNodes?: string[];
    allowAvoidFallback?: boolean;
  } = {}
): Promise<string> {
  return nodeSelectionCoordinator.coalesceAutomatic(options.signal, (signal) =>
    performPreferredAutoNode({ ...options, signal })
  );
}

async function performPreferredAutoNode(options: {
  signal: AbortSignal;
  avoidNode?: string;
  avoidNodes?: string[];
  allowAvoidFallback?: boolean;
}): Promise<string> {
  const settings = await settingsStore.read();
  const policy = await readNodeSelectionPolicy();
  const expectedRegion = expectedExitRegionCode(policy.preferredRegion);
  let selectedExitRegion: string | undefined;
  let selectedViaVerificationFallback = false;
  const probedExitRegions = new Map<string, string | undefined>();
  const mihomoApi = createRuntimeMihomoApi({ secret: settings.controllerSecret });
  const selectedNode = await mihomoApi.selectBestUsableNodeForStrategy('auto', {
    avoidNode: options.avoidNode,
    avoidNodes: options.avoidNodes,
    allowAvoidFallback: options.allowAvoidFallback,
    policy,
    signal: options.signal,
    verifyNode: async (nodeName, signal) => {
      const actualRegion = await probeProxyExitRegionCode(runtimePorts.mixedPort, { signal }).catch((error) => {
        signal?.throwIfAborted();
        appendLog(`出口地区验证失败: ${nodeName} (${formatError(error)})`);
        return undefined;
      });
      probedExitRegions.set(nodeName, actualRegion);
      if (!expectedRegion) {
        selectedExitRegion = actualRegion;
        return true;
      }
      if (!isNodeInPreferredRegion(nodeName, policy.preferredRegion)) {
        if (policy.regionFallback !== 'global') return false;
        selectedExitRegion = actualRegion;
        return true;
      }
      if (actualRegion !== expectedRegion) {
        appendLog(`节点出口地区不符: ${nodeName} (${actualRegion ?? 'unknown'} != ${expectedRegion})`);
        return false;
      }
      selectedExitRegion = actualRegion;
      return true;
    },
    verifyFallbackNode:
      expectedRegion && policy.regionFallback === 'global'
        ? async (nodeName, signal) => {
            signal?.throwIfAborted();
            selectedExitRegion = probedExitRegions.get(nodeName);
            selectedViaVerificationFallback = true;
            return true;
          }
        : undefined
  });
  if (!selectedNode) {
    throw new Error(
      policy.preferredRegion === 'auto'
        ? '没有可用节点'
        : policy.regionFallback === 'strict'
          ? `没有可用的${preferredRegionLabel(policy.preferredRegion)}节点`
          : '没有可用节点'
    );
  }
  const fallbackNotice = resolveNodeSelectionFallbackNotice({
    policy,
    selectedNode,
    selectedExitRegion,
    selectedViaVerificationFallback
  });
  if (fallbackNotice) publishNodeSelectionNotice(fallbackNotice);
  return selectedNode;
}

async function withTrayRefresh<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } finally {
    refreshTrayMenu();
  }
}

async function performStartProxy(signal?: AbortSignal, requestedIntentGeneration?: number): Promise<AppSnapshot> {
  return runProxyStartSequence(
    {
      throwIfAborted,
      throwIfNetworkRepairInProgress,
      requireTrafficIdentity,
      requestStartIntent: (requested) => requested ?? runtimeIntent.requestStart(),
      throwIfIntentCanceled: throwIfRuntimeIntentCanceled,
      isIntentCurrent: (generation) => runtimeIntent.isCurrent(generation),
      syncRequiredRemoteConfig,
      startLifecycle: startLifecycleWithSafeRetry,
      activatePending: () => trafficRegistration.activatePending(),
      getRuntimeTrafficProxyUrl,
      stopLifecycle: () => lifecycle.stop(),
      cancelIntent: () => runtimeIntent.cancel(),
      createRefineSignal: beginPreferredAutoNodeRefine,
      readSettings: () => settingsStore.read(),
      selectPreferredAutoNode,
      isExpectedCancellation: isExpectedOperationCancellation,
      startTraffic: () => {
        trafficTracker.start();
        trafficReporter.start();
      },
      clearLastError,
      scheduleNodeHealthCheck,
      createSnapshot,
      sendSnapshot: sendSnapshotToWindows,
      appendLog,
      formatError,
      recordStartError: (error) => recordError('启动失败', error)
    },
    signal,
    requestedIntentGeneration
  );
}

function beginPreferredAutoNodeRefine(): AbortSignal {
  abortPreferredAutoNodeRefine();
  const controller = new AbortController();
  preferredAutoNodeRefineController = controller;
  return controller.signal;
}

function abortPreferredAutoNodeRefine(): void {
  preferredAutoNodeRefineController?.abort(new Error('operation canceled'));
  preferredAutoNodeRefineController = undefined;
}

function startProxy(signal?: AbortSignal): Promise<AppSnapshot> {
  return appRuntimeCoordinator.start(signal);
}

async function selectBestAutoNode(signal?: AbortSignal): Promise<AppSnapshot> {
  throwIfAborted(signal);
  await requireTrafficIdentity();
  nodeHealthCoordinator.invalidate();
  let settings = await settingsStore.read();
  if (lifecycle.getStatus() !== 'running') {
    await settingsStore.update({ strategy: 'auto', selectedNode: null });
    await startProxy(signal);
    return createSnapshot();
  }

  return nodeSelectionCoordinator.runUserAction(async () => {
    throwIfAborted(signal);
    if (lifecycle.getStatus() !== 'running') {
      throw new Error('代理已停止，请重新启动后再选点');
    }
    const selectedNode = await performPreferredAutoNode({ signal: signal ?? new AbortController().signal });
    throwIfAborted(signal);
    settings = await settingsStore.update({ strategy: 'auto', selectedNode: null });

    const mihomoApi = createRuntimeMihomoApi({ secret: settings.controllerSecret });
    await mihomoApi.closeConnections().catch((error) => appendLog(`关闭旧连接失败: ${formatError(error)}`));
    await mihomoApi.flushDnsCache().catch((error) => appendLog(`刷新 DNS 缓存失败: ${formatError(error)}`));
    appendLog(`已自动选择可用节点: ${selectedNode}`);
    clearLastError();
    scheduleNodeHealthCheck(0);
    return createSnapshot();
  });
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

async function startLifecycleWithSafeRetry(
  signal?: AbortSignal,
  intentGeneration?: number,
  options: { allowDuringNetworkRepair?: boolean } = {}
): Promise<void> {
  return appRuntimeActions.start(signal, intentGeneration, options);
}

async function startLifecycleForUser(signal?: AbortSignal): Promise<void> {
  await appRuntimeCoordinator.start(signal);
}

async function performRestartLifecycleForUser(signal?: AbortSignal): Promise<void> {
  const intentGeneration = runtimeIntent.capture();
  if (intentGeneration === undefined) throw new Error('proxy start canceled');
  await restartLifecycleForIntent(intentGeneration, signal);
}

function restartLifecycleForUser(signal?: AbortSignal): Promise<void> {
  return appRuntimeCoordinator.restart(signal);
}

async function restartLifecycleForExpectedIntent(intentGeneration: number, signal?: AbortSignal): Promise<void> {
  throwIfRuntimeIntentCanceled(intentGeneration);
  await appRuntimeCoordinator.restart(signal);
  throwIfRuntimeIntentCanceled(intentGeneration);
}

async function restartLifecycleForIntent(intentGeneration: number, signal?: AbortSignal): Promise<void> {
  return appRuntimeActions.restart(intentGeneration, signal);
}

function runtimeActionsForIntent(intentGeneration: number) {
  return appRuntimeActions.forIntent(intentGeneration);
}

async function handleTrafficIdentityInvalidated(): Promise<void> {
  runtimeIntent.cancel();
  appRuntimeCoordinator.stopRecovery();
  stopRemoteConfigPolling();
  trafficTracker.stop();
  trafficReporter.stop();
  stopNodeHealthMonitor();
  await applyRemoteSubscription(undefined).catch((error) =>
    appendLog(`traffic identity invalidation subscription cleanup failed: ${formatError(error)}`)
  );

  await lifecycle
    .stop()
    .catch((error) => appendLog(`traffic identity invalidation stop failed: ${formatError(error)}`));
  await broadcastSnapshot().catch((error) => console.error('broadcast snapshot failed', error));
  refreshTrayMenu();
  if (!networkRepairInProgress && !cleanupStarted && !cleanupFinished && !isQuitting) {
    startRemoteConfigPolling();
  }
}

async function performStopProxy(signal?: AbortSignal): Promise<AppSnapshot> {
  signal?.throwIfAborted();
  abortPreferredAutoNodeRefine();
  runtimeIntent.cancel();
  await trafficTracker.flush().catch((error) => appendLog(`流量统计失败: ${formatError(error)}`));
  signal?.throwIfAborted();
  await trafficReporter.reportPending().catch((error) => appendLog(`流量上报失败: ${formatError(error)}`));
  signal?.throwIfAborted();
  trafficTracker.stop();
  await lifecycle.stop();
  signal?.throwIfAborted();
  return createSnapshot();
}

function stopProxy(): Promise<AppSnapshot> {
  return appRuntimeCoordinator.stop();
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
          appRuntimeCoordinator.stopRecovery();
          stopRemoteConfigPolling();
        },
        runTargetedRepair: runIssueTargetedRepair,
        compensateCanceledTargetedRepair: () => systemProxy.restoreAfterRepairCancellation(),
        onTargetedRepairError: (issueKind, error) =>
          appendLog(`针对性修复未完成，继续完整修复 (${issueKind}): ${formatError(error)}`),
        onSupplementalRepairError: (error) =>
          appendLog(`关键修复已完成，部分系统网络清理未完成: ${formatError(error)}`),
        repairLifecycle: (repairSignal) => lifecycle.repair(repairSignal),
        clearRuntimeCache: () => clearMihomoRepairCache(userDataDir),
        startRuntime: (startSignal, intentGeneration) =>
          startLifecycleWithSafeRetry(startSignal, intentGeneration, { allowDuringNetworkRepair: true }),
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
  }
}

async function registerTrafficIdentity(input: Parameters<TrafficReporter['register']>[0]): Promise<AppSnapshot> {
  return trafficRegistration.runExclusiveForeground(() => performTrafficIdentityRegistration(input));
}

async function performTrafficIdentityRegistration(
  input: Parameters<TrafficReporter['register']>[0]
): Promise<AppSnapshot> {
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
      await subscriptionCoordinator
        .reschedule()
        .catch((error) =>
          recordPostCommitIssue(
            '\u7528\u6237\u5df2\u5207\u6362\uff0c\u8c03\u5ea6\u72b6\u6001\u66f4\u65b0\u5931\u8d25',
            error
          )
        );
      const activeIntentGeneration = runtimeIntent.capture();
      const newIntentGeneration = activeIntentGeneration === undefined ? undefined : runtimeIntent.requestStart();
      let newIdentityConfigReady = true;
      try {
        await syncRequiredRemoteConfig({
          proxyUrl: getRuntimeTrafficProxyUrl(),
          quiet: true
        });
      } catch (error) {
        newIdentityConfigReady = false;
        recordPostCommitIssue(
          '\u7528\u6237\u5df2\u5207\u6362\uff0c\u65b0\u7528\u6237\u914d\u7f6e\u540c\u6b65\u5931\u8d25',
          error
        );
      }
      if (!newIdentityConfigReady) {
        try {
          await appRuntimeCoordinator.stop();
        } catch (error) {
          recordPostCommitIssue(
            '\u7528\u6237\u5df2\u5207\u6362\uff0c\u672a\u83b7\u5f97\u4e91\u7aef\u914d\u7f6e\u540e\u505c\u6b62\u4ee3\u7406\u5931\u8d25',
            error
          );
        }
      } else if (newIntentGeneration !== undefined) {
        try {
          await restartLifecycleForExpectedIntent(newIntentGeneration);
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
  abortPreferredAutoNodeRefine();
  runtimeIntent.cancel();
  await appRuntimeCoordinator.stop();
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
  ipcMain.handle(ipcChannels.getDesktopNoticeSnapshot, async () => toDesktopNoticeSnapshot(await createSnapshot()));
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
            if (!isExpectedOperationCancellation(error)) recordError('启动失败', error);
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
    return runCancelableOperation(event.sender.id, request, async (signal) =>
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
      })
    );
  });
  ipcMain.handle(ipcChannels.selectNode, async (_event, name: string) => {
    if (lifecycle.getStatus() !== 'running') {
      await requireTrafficIdentity();
      await startLifecycleForUser();
    }
    nodeHealthCoordinator.invalidate();
    return nodeSelectionCoordinator.runUserAction(async () => {
      const settings = await settingsStore.read();
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
  });
  ipcMain.handle(ipcChannels.selectBestAutoNode, async (event, request?: OperationRequest) => {
    return runCancelableOperation(event.sender.id, request, async (signal) =>
      withTrayRefresh(async () => {
        try {
          const snapshot = await selectBestAutoNode(signal);
          sendSnapshotToWindows(snapshot);
          return snapshot;
        } catch (error) {
          if (!isExpectedOperationCancellation(error)) recordError('自动选择节点失败', error);
          throw error;
        }
      })
    );
  });
  ipcMain.handle(ipcChannels.selectStrategy, async (_event, strategy) => {
    nodeHealthCoordinator.invalidate();
    return nodeSelectionCoordinator.runUserAction(async () => {
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
  });
  ipcMain.handle(ipcChannels.setMode, async (_event, mode) => {
    nodeHealthCoordinator.invalidate();
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
    return nodeTestOperations.replace(async ({ signal, isCurrent }) => {
      const progressNotifier = createSnapshotProgressNotifier(300, isCurrent);
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
            signal,
            onNodeTested: async (node) => {
              await updateCurrentNodeDelayFromManualTest(node.name, node.delay, node.testState);
            },
            onProgress: () => {
              if (isCurrent()) progressNotifier.notify();
            }
          }
        );
        if (isCurrent()) sendSnapshotToWindows(snapshot);
        return snapshot;
      } finally {
        progressNotifier.clear();
      }
    });
  });
  ipcMain.handle(ipcChannels.cancelNodeTests, async () => {
    return nodeTestOperations.cancelThen(async () => {
      const snapshot = await createSnapshot();
      sendSnapshotToWindows(snapshot);
      return snapshot;
    });
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
    return runCancelableOperation(event.sender.id, request, async (signal) =>
      withTrayRefresh(async () => {
        throwIfAborted(signal);
        await requireTrafficIdentity();
        await subscriptionCoordinator.refresh('subscription', { source: 'manual', signal });
        throwIfAborted(signal);
        return createSnapshot();
      })
    );
  });
  ipcMain.handle(ipcChannels.saveSettings, async (event, settings, intent, request?: OperationRequest) => {
    return runCancelableOperation(event.sender.id, request, async (signal) =>
      withTrayRefresh(async () => {
        const lastErrorBeforeSave = lastError;
        const issueBeforeSave = classifyDiagnosticIssue(lastErrorBeforeSave);
        try {
          await saveSubscriptionSettings(
            {
              settingsStore,
              lifecycle,
              runtime: userRuntimeActions,
              remoteConfig: {
                readSnapshot: () => remoteConfigClient.getActiveConfigSnapshot(),
                update: async (input, updateSignal) =>
                  (
                    await remoteConfigClient.updateUserConfig(input, {
                      proxyUrl: getRuntimeTrafficProxyUrl(),
                      signal: updateSignal
                    })
                  ).config,
                apply: async () => {
                  const snapshot = await remoteConfigClient.getActiveConfigSnapshot();
                  await applyRemoteSubscription(snapshot.config, snapshot);
                }
              },
              createSnapshot
            },
            settings,
            { signal, intent }
          );
          if (isDiagnosticIssueResolvedByOperation('save-settings', issueBeforeSave)) {
            clearLastErrorIfUnchanged(lastErrorBeforeSave);
          }
          await subscriptionCoordinator.reschedule();
          return createSnapshot();
        } catch (error) {
          recordError('保存设置失败', error);
          throw error;
        }
      })
    );
  });
  ipcMain.handle(ipcChannels.registerTrafficIdentity, async (_event, input) => {
    const snapshot = await registerTrafficIdentity(input);
    sendSnapshotToWindows(snapshot);
    return snapshot;
  });
  ipcMain.handle(ipcChannels.acknowledgeUserNotice, async (_event, revision) => {
    await remoteConfigClient.acknowledgeNotice(revision, { proxyUrl: getRuntimeTrafficProxyUrl() });
    const snapshot = await createSnapshot();
    sendSnapshotToWindows(snapshot);
    return snapshot;
  });
  ipcMain.handle(ipcChannels.acknowledgeDesktopNotice, async (_event, revision) => {
    await remoteConfigClient.acknowledgeNotice(revision, { proxyUrl: getRuntimeTrafficProxyUrl() });
    const snapshot = await createSnapshot();
    sendSnapshotToWindows(snapshot);
    return toDesktopNoticeSnapshot(snapshot);
  });
  ipcMain.handle(ipcChannels.wakeRemoteConfig, async () => {
    wakeRemoteConfig();
  });
  ipcMain.handle(ipcChannels.syncRemoteConfig, async (event, request?: OperationRequest) => {
    return runCancelableOperation(event.sender.id, request, async (signal) =>
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
            intentGeneration: runtimeIntent.capture(),
            source: 'manual'
          });
          if (isDiagnosticIssueResolvedByOperation('sync-settings', issueBeforeSync)) {
            clearLastErrorIfUnchanged(lastErrorBeforeSync);
          }
          return createSnapshot();
        } catch (error) {
          recordError('同步设置失败', error);
          throw error;
        }
      })
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
    void createWindow().catch((error) => recordError('创建主窗口失败', error));
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  wakeRemoteConfig();
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
    void createPetWindow().catch((error) => recordError('创建桌宠窗口失败', error));
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
    scheduleNoticeLayout();
    refreshTrayMenu();
    return;
  }

  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.showInactive();
  applyPetWindowTaskbarPolicy(petWindow);
  setPetMousePassthrough(true, true);
  syncPetStateToRuntime();
  scheduleNoticeLayout();
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

function enableLegacyLaunchAtLogin() {
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
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

  try {
    await windowsStartupTask.setEnabled(enabled);
  } catch (error) {
    if (!enabled || !(error instanceof StartupTaskWriteError)) throw error;
    enableLegacyLaunchAtLogin();
    appendLog('计划任务不可用，已改用兼容开机自启');
    return;
  }
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

  const legacyEnabled = isLegacyLaunchAtLoginEnabled();
  try {
    await windowsStartupTask.reconcile(legacyEnabled);
    clearLegacyLaunchAtLogin();
  } catch (error) {
    if (error instanceof StartupTaskWriteError) {
      if (windowsStartupTask.hasManagedLegacyTask()) {
        clearLegacyLaunchAtLogin();
        return;
      }
      if (legacyEnabled) return;
    }
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
        void dockPetToBottomRight().catch((error) => appendLog(`桌宠贴边失败: ${formatError(error)}`));
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
        void cleanupBeforeExit().catch((error) => recordError('退出清理失败', error));
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
  void settingsStore
    .update({
      petWindow: {
        x: bounds.x,
        y: bounds.y
      }
    })
    .catch((error) => appendLog(`保存桌宠位置失败: ${formatError(error)}`));
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
  scheduleNoticeLayout();
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
    scheduleNoticeLayout();

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
    scheduleNoticeLayout();
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
    scheduleNoticeLayout();
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
        void cleanupBeforeExit().catch((error) => recordError('退出清理失败', error));
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
      additionalArguments: ['--youyu-window-role=main'],
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

  win.on('focus', () => wakeRemoteConfig());

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

async function createNoticeWindow(): Promise<BrowserWindow | undefined> {
  if (noticeWindow && !noticeWindow.isDestroyed()) return noticeWindow;
  if (cleanupStarted || isQuitting) return undefined;

  const win = new BrowserWindow({
    ...noticeWindowSize,
    useContentSize: true,
    title: 'YouYu 通知',
    type: 'toolbar',
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    focusable: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      additionalArguments: ['--youyu-window-role=notice'],
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: true
    }
  });
  noticeWindow = win;
  secureRendererNavigation(win);
  win.setAlwaysOnTop(true, 'floating');
  win.setFocusable(true);
  win.setSkipTaskbar(true);
  win.setIgnoreMouseEvents(false);

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`notice preload failed: ${preloadPath}`, error);
  });
  win.once('ready-to-show', () => {
    void syncNoticeWindow().catch((error) => console.error('notice window initial synchronization failed', error));
  });
  win.on('closed', () => {
    if (noticeWindow === win) {
      noticeWindow = null;
    }
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    url.searchParams.set('view', 'notice');
    await win.loadURL(url.toString());
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'notice' }
    });
  }
  return win;
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
    focusable: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      additionalArguments: ['--youyu-window-role=pet'],
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
  win.on('move', () => scheduleNoticeLayout());
  win.on('show', () => scheduleNoticeLayout());
  win.on('hide', () => scheduleNoticeLayout());

  win.once('ready-to-show', () => {
    applyPetWindowVisibility();
    applyPetWindowTaskbarPolicy(win);
    sendPetState();
    syncPetStateToRuntime();
    scheduleNoticeLayout();
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
    scheduleNoticeLayout();
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
  appWindowCoordinator.dispose();
  updateCoordinator.pause();
  stopNodeHealthMonitor();
  appRuntimeCoordinator.stopRecovery();
  await nodeTestOperations.cancel();
  await nodeSelectionCoordinator.cancel();
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
        void startLifecycleWithSafeRetry(undefined, restoredIntentGeneration).catch((restartError) =>
          recordError('退出取消后的代理恢复失败', restartError)
        );
      } else {
        appRuntimeCoordinator.scheduleRecovery(0);
      }
    }
    showMainWindow();
    if (options.throwOnFailure) throw error;
    return false;
  }
  cleanupFinished = true;
  updateCoordinator.dispose();
  subscriptionCoordinator.dispose();
  nodeHealthCoordinator.dispose();
  appRuntimeCoordinator.dispose();
  try {
    localDiagnosticSession?.close();
  } catch (error) {
    appLogs.append(`本地诊断结束记录失败: ${formatError(error)}`);
  }
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
      void cleanupBeforeExit().catch((error) => recordError('退出清理失败', error));
      return;
    }
    const relaunchAcknowledgement = resolveUpdateRelaunchAcknowledgementRequest(commandLine);
    if (
      shouldReportRecoveredUpdateInstallFailure({
        launchedAfterSuccessfulUpdate,
        receivedFailedRelaunch: commandLine.includes(updateInstallFailedRelaunchArgument)
      })
    ) {
      reportRecoveredUpdateInstallFailure();
      showMainWindow();
    } else if (!commandLine.includes('--hidden') && !commandLine.includes('--startup')) {
      showMainWindow();
    }
    if (commandLine.includes(resumeProxyAfterRelaunchArgument)) {
      resumeProxyFromRelaunch();
    }
    if (relaunchAcknowledgement) {
      void writeUpdateRelaunchAcknowledgement(relaunchAcknowledgement, { appVersion }).catch((error) =>
        recordError('更新后重开确认失败', error)
      );
    }
  });

  app
    .whenReady()
    .then(async () => {
      initializeLocalDiagnostics();
      if (startupUpdateRelaunchAcknowledgement) {
        void writeUpdateRelaunchAcknowledgement(startupUpdateRelaunchAcknowledgement, { appVersion }).catch((error) =>
          recordError('更新后重开确认失败', error)
        );
      }
      try {
        app.configureHostResolver(createHostResolverOptions());
      } catch (error) {
        appendLog(`应用内 DNS 配置失败，继续使用系统解析: ${formatError(error)}`);
      }
      await prepareUpdateNetworkSession(electronSession.fromPartition(directNetworkPartition, { cache: false })).catch(
        (error) => appendLog(`后台直连会话初始化失败: ${formatError(error)}`)
      );
      await systemProxy.restore().catch((error) => recordError('恢复遗留系统代理失败', error));
      await allocateRuntimePorts();
      registerIpc();
      setupAutoUpdates();
      if (
        shouldReportRecoveredUpdateInstallFailure({
          launchedAfterSuccessfulUpdate,
          receivedFailedRelaunch: recoveredFromUpdateInstallFailure
        })
      ) {
        reportRecoveredUpdateInstallFailure();
      }
      await reconcileLaunchAtLogin();
      createTray();
      applicationInitializationReady = true;
      const initialWindow = createWindow();
      void initialWindow.catch((error) => recordError('创建主窗口失败', error));
      startRemoteConfigPolling();
      void broadcastSnapshot().catch((error) => recordError('初始化通知快照失败', error));
      void refreshTrafficTotalsFromServer();
      if (petFeatureEnabled) {
        void createPetWindow().catch((error) => recordError('创建桌宠窗口失败', error));
      }
      if (updateRelaunchResumeRequested) {
        resumeProxyFromRelaunch();
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
      void cleanupBeforeExit().catch((error) => recordError('退出清理失败', error));
    }
  }
});
