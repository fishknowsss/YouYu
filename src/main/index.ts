import { app, BrowserWindow, Menu, Tray, ipcMain, screen, type Rectangle } from 'electron';
import { autoUpdater } from 'electron-updater';
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { createLifecycleController, type MihomoRuntime } from './lifecycle';
import { connectivityServices, testAllConnectivity, testConnectivity } from './connectivity';
import { createMihomoApiClient } from './mihomo/api';
import { strategyLabels, strategyTargets } from './mihomo/config';
import { createMihomoRuntime } from './mihomo/process';
import { createSystemProxyAdapter } from './platform/systemProxy';
import { SettingsStore } from './storage/settings';
import {
  availabilitySnapshotFromRecord,
  createAvailabilityRecord,
  createEmptyCurrentNodeHealth,
  NodeHealthStore
} from './storage/nodeHealth';
import { resolveDefaultSubscriptionUrl } from './defaultSubscription';
import { TrafficReporter } from './traffic/reporter';
import { TrafficStore } from './traffic/store';
import { TrafficTracker } from './traffic/tracker';
import { RemoteConfigClient } from './remoteConfig';
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
  type RemoteControlConfig,
  type StrategyGroup,
  type StrategyKey
} from '../shared/ipc';

declare const __YOUYU_DISABLE_PET__: boolean;
declare const __YOUYU_BUILD_CHANNEL__: string;

const appId = 'studio.youyu.proxy';
const isDev = !app.isPackaged;
const startHidden = process.argv.includes('--hidden') || process.argv.includes('--startup');
const startupTaskName = 'YouYu';
const execFileAsync = promisify(execFile);
let mainWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
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
let autoUpdatesConfigured = false;
let updateSnapshot: AppUpdateSnapshot = {
  currentVersion: '0.0.0',
  buildChannel: 'standard',
  updateChannel: 'latest',
  status: 'idle'
};
let nodeHealthTimer: ReturnType<typeof setTimeout> | undefined;
let nodeHealthCheckRunning = false;
let currentNodeHealthFailures = 0;
let currentNodeHealthFailureName = '';
let currentNodeHealth = createEmptyCurrentNodeHealth('', connectivityServices.length);
let currentNodeAvailabilityRunning = false;
let currentNodeAvailabilityNode = '';
let runtimeRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let runtimeRecoveryRunning = false;
let runtimeRecoveryFailures = 0;
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
let lastError: string | undefined;
const appLogs: string[] = [];
const foldedMihomoDialWarnings = new Map<string, { count: number; lastAt: number }>();
const petFeatureEnabled = !__YOUYU_DISABLE_PET__;
const petWindowSize = {
  width: 190,
  height: 212
};
const petDragFrameMs = 16;
const petSideBlinkDelayMs = 7000;
const petSideSleepDelayMs = 28000;
const petSideDropDelayMs = 65000;
const petTopDropDelayMs = 52000;
const nodeHealthInitialDelayMs = 15000;
const currentNodeDelayRefreshMs = 15 * 60 * 1000;
const nodeHealthIntervalMs = currentNodeDelayRefreshMs;
const nodeHealthRepairDelayMs = 3000;
const nodeHealthRetryDelayMs = 8000;
const nodeHealthFailureThreshold = 2;
const remoteConfigSyncIntervalMs = 3 * 60 * 1000;
const updatePeriodicIntervalMs = 30 * 60 * 1000;
const runtimeRecoveryInitialDelayMs = 1500;
const runtimeRecoveryMaxDelayMs = 60000;

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
const appVersion = readPackageVersion();
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
const trafficStore = new TrafficStore(app.getPath('userData'));
const nodeHealthStore = new NodeHealthStore(app.getPath('userData'));
const remoteConfigClient = new RemoteConfigClient({
  baseDir: app.getPath('userData'),
  endpoint: readOptionalText(trafficApiUrlPath),
  appVersion,
  store: trafficStore
});
const trafficReporter = new TrafficReporter({
  store: trafficStore,
  endpoint: readOptionalText(trafficApiUrlPath),
  appVersion,
  getProxyUrl: getRuntimeTrafficProxyUrl,
  onError: (error) => appendLog(`流量上报失败: ${formatError(error)}`)
});
const trafficTracker = new TrafficTracker({
  store: trafficStore,
  isRunning: () => lifecycle.getStatus() === 'running',
  readRuntimeStats: async () => {
    const settings = await settingsStore.read();
    return createRuntimeMihomoApi({ secret: settings.controllerSecret }).getRuntimeStats({
      includeConnections: true
    });
  },
  onError: (error) => appendLog(`流量统计失败: ${formatError(error)}`)
});
const mihomoBinaryPath = isDev
  ? join(process.cwd(), 'resources/mihomo/win-x64/mihomo.exe')
  : join(process.resourcesPath, 'mihomo/win-x64/mihomo.exe');
const windowIconPath = isDev
  ? join(process.cwd(), 'build/icon.png')
  : join(process.resourcesPath, 'assets/icon.png');
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
        getPorts: allocateRuntimePorts,
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

function readPackageVersion(): string {
  try {
    const packagePath = isDev ? join(process.cwd(), 'package.json') : join(process.resourcesPath, 'package.json');
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function appendLog(message: string) {
  const normalizedMessage = normalizeDiagnosticLog(message);
  if (!normalizedMessage) return;

  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${normalizedMessage}`;
  appLogs.push(line);
  if (appLogs.length > 200) {
    appLogs.splice(0, appLogs.length - 200);
  }
}

function normalizeDiagnosticLog(message: string): string | undefined {
  const warning = parseMihomoDialWarning(message);
  if (!warning) return message;

  const now = Date.now();
  const previous = foldedMihomoDialWarnings.get(warning.signature);
  if (previous && now - previous.lastAt < 120000) {
    previous.count += 1;
    previous.lastAt = now;
    return undefined;
  }

  const foldedText = previous?.count ? `，已折叠 ${previous.count} 条` : '';
  foldedMihomoDialWarnings.set(warning.signature, { count: 0, lastAt: now });
  trimFoldedMihomoDialWarnings();
  return `连接警告：${warning.target} 访问失败（${warning.network}${foldedText}）`;
}

function parseMihomoDialWarning(
  message: string
): { signature: string; target: string; network: string } | undefined {
  if (!message.includes('[mihomo]') || !/level=warning/i.test(message) || !/\[(?:TCP|UDP)\]\s+dial/i.test(message)) {
    return undefined;
  }

  const network = message.match(/\[(TCP|UDP)\]\s+dial/i)?.[1]?.toUpperCase() ?? '连接';
  const rulePayload = message.match(/match\s+([A-Za-z-]+\/[^")\s]+)/i)?.[1];
  const target = rulePayload?.split('/').pop()?.trim() || message.match(/dial\s+([^ ]+)/i)?.[1] || '外部站点';
  return {
    signature: `${network}:${rulePayload ?? target}`.toLowerCase(),
    target,
    network
  };
}

function trimFoldedMihomoDialWarnings() {
  if (foldedMihomoDialWarnings.size <= 40) return;
  const oldest = [...foldedMihomoDialWarnings.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0]?.[0];
  if (oldest) foldedMihomoDialWarnings.delete(oldest);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function recordError(context: string, error: unknown) {
  lastError = `${context}: ${formatError(error)}`;
  appendLog(lastError);
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

async function syncRemoteConfig(
  options: { proxyUrl?: string; restartIfRunning?: boolean; throwOnError?: boolean } = {}
): Promise<boolean> {
  try {
    const result = await remoteConfigClient.sync({ proxyUrl: options.proxyUrl });
    const subscriptionChanged = await applyRemoteSubscription(result.config);
    if (!result.changed && !subscriptionChanged) return false;

    appendLog(`remote config updated: v${result.config?.version ?? 0}`);
    if (options.restartIfRunning && lifecycle.getStatus() === 'running') {
      await lifecycle.restart();
    }
    return true;
  } catch (error) {
    appendLog(`remote config sync failed: ${formatError(error)}`);
    if (options.throwOnError) throw error;
    return false;
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
  if (remoteConfigSyncRunning || cleanupStarted || cleanupFinished || isQuitting) return;
  remoteConfigSyncRunning = true;
  try {
    await syncRemoteConfig({
      proxyUrl: getRuntimeTrafficProxyUrl(),
      restartIfRunning: true
    });
  } finally {
    remoteConfigSyncRunning = false;
  }
}

async function applyRemoteSubscription(config?: RemoteControlConfig): Promise<boolean> {
  const nextRemoteSubscriptionUrl = config?.enabled ? config.subscriptionUrl?.trim() ?? '' : '';
  const settings = await settingsStore.read();
  const currentRemoteSubscriptionUrl = settings.remoteSubscriptionUrl ?? '';
  if (currentRemoteSubscriptionUrl === nextRemoteSubscriptionUrl) {
    return false;
  }

  await settingsStore.update({
    remoteSubscriptionUrl: nextRemoteSubscriptionUrl || null
  });
  appendLog(nextRemoteSubscriptionUrl ? '远程订阅已更新' : '远程订阅已清除');
  scheduleSubscriptionRefresh();
  return true;
}

function shouldRetryRegistrationViaProxy(error: unknown): boolean {
  const message = formatError(error);
  if (message.includes('traffic endpoint not configured')) return false;
  if (message.includes('traffic activation failed: 400')) return false;
  if (message.includes('traffic activation failed: 403')) return false;
  if (/traffic activation failed: (408|429|5\d\d)/.test(message)) return true;
  return [
    'fetch failed',
    'Failed to fetch',
    'traffic request timed out',
    'traffic proxy connect timed out',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN'
  ].some((needle) => message.includes(needle));
}

function isTrafficActivationAuthFailure(error: unknown): boolean {
  const message = formatError(error);
  return message.includes('traffic activation failed: 400') || message.includes('traffic activation failed: 403');
}

function clearLastError() {
  lastError = undefined;
}

function setupAutoUpdates() {
  if (autoUpdatesConfigured) return;
  autoUpdatesConfigured = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
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
    setUpdateSnapshot({
      status: 'downloading',
      percent: normalizeUpdatePercent(progress.percent)
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

  if (updateSnapshot.status === 'downloaded' || updateCheckRunning) {
    return createSnapshot();
  }

  updateCheckRunning = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateFailure(error);
  } finally {
    updateCheckRunning = false;
    scheduleUpdateCheck(updatePeriodicIntervalMs);
  }

  return createSnapshot();
}

function setUpdateFailure(error: unknown) {
  const message = formatError(error);
  if (updateSnapshot.status !== 'failed' || updateSnapshot.message !== message) {
    appendLog(`检查更新失败: ${message}`);
  }
  setUpdateSnapshot({
    status: 'failed',
    checkedAt: new Date().toISOString(),
    message
  });
}

async function installDownloadedUpdate(): Promise<AppSnapshot> {
  if (updateSnapshot.status !== 'downloaded') {
    throw new Error('update not downloaded');
  }

  const snapshot = await createSnapshot();
  await prepareForUpdateInstall();
  cleanupFinished = true;
  isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
  return snapshot;
}

async function prepareForUpdateInstall(): Promise<void> {
  await trafficTracker.flush().catch((error) => appendLog(`流量统计失败: ${formatError(error)}`));
  await trafficReporter.reportPending().catch((error) => appendLog(`流量上报失败: ${formatError(error)}`));
  trafficTracker.stop();
  trafficReporter.stop();
  if (lifecycle.getStatus() !== 'stopped') {
    await lifecycle.stop().catch((error) => appendLog(`更新前停止代理失败: ${formatError(error)}`));
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

lifecycle = createLifecycleController({
  proxy: createSystemProxyAdapter({
    shouldManageProxy: async () => {
      const settings = await settingsStore.read();
      return settings.systemProxyEnabled;
    },
    getProxyServer: () => `127.0.0.1:${runtimePorts.mixedPort}`
  }),
  mihomo: mihomoRuntime,
  onStatusChange: (status) => {
    if (status === 'running') {
      clearRuntimeRecoveryTimer();
      runtimeRecoveryFailures = 0;
      startNodeHealthMonitor();
    } else {
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

function clearSubscriptionRefreshTimer() {
  if (subscriptionRefreshTimer) {
    clearTimeout(subscriptionRefreshTimer);
    subscriptionRefreshTimer = undefined;
  }
}

function scheduleSubscriptionRefresh() {
  clearSubscriptionRefreshTimer();
  if (lifecycle.getStatus() !== 'running') return;

  void settingsStore
    .read()
    .then((settings) => {
      const intervalHours = settings.subscriptionRefreshIntervalHours;
      if (!settings.subscriptionUrl.trim() || intervalHours <= 0 || lifecycle.getStatus() !== 'running') {
        return;
      }

      subscriptionRefreshTimer = setTimeout(() => {
        void refreshSubscriptionInBackground();
      }, intervalHours * 60 * 60 * 1000);
    })
    .catch((error) => {
      recordError('订阅刷新计划失败', error);
    });
}

async function refreshSubscriptionInBackground() {
  if (lifecycle.getStatus() !== 'running') {
    scheduleSubscriptionRefresh();
    return;
  }

  try {
    appendLog('后台刷新订阅');
    const snapshot = await updateSubscriptionNodes({
      settingsStore,
      lifecycle,
      createMihomoApi: createRuntimeMihomoApi,
      createSnapshot
    });
    sendSnapshotToWindows(snapshot);
    clearLastError();
  } catch (error) {
    recordError('后台刷新订阅失败', error);
    await broadcastSnapshot().catch((broadcastError) => console.error('broadcast snapshot failed', broadcastError));
  } finally {
    refreshTrayMenu();
    scheduleSubscriptionRefresh();
  }
}

function startNodeHealthMonitor() {
  scheduleNodeHealthCheck(nodeHealthInitialDelayMs);
}

function stopNodeHealthMonitor() {
  if (nodeHealthTimer) {
    clearTimeout(nodeHealthTimer);
    nodeHealthTimer = undefined;
  }
  nodeHealthCheckRunning = false;
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

function updateCurrentNodeAvailabilityStatus(
  nodeName: string,
  status: CurrentNodeHealth['availability']['status']
) {
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

  if (
    currentNodeHealth.availability.status === 'measured' &&
    !isLocalToday(currentNodeHealth.availability.checkedAt)
  ) {
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
  if (isQuitting || cleanupStarted || cleanupFinished) return;
  if (lifecycle.getStatus() === 'stopped') return;

  clearRuntimeRecoveryTimer();
  runtimeRecoveryTimer = setTimeout(() => {
    runtimeRecoveryTimer = undefined;
    void runRuntimeRecovery();
  }, delayMs);
}

async function runRuntimeRecovery() {
  if (runtimeRecoveryRunning || isQuitting || cleanupStarted || cleanupFinished) return;
  if (lifecycle.getStatus() === 'stopped') return;

  runtimeRecoveryRunning = true;
  try {
    appendLog('检测到代理异常，正在自动修复');
    await lifecycle.repair().catch((error) => appendLog(`自动修复准备失败: ${formatError(error)}`));
    const snapshot = await startProxy();
    runtimeRecoveryFailures = 0;
    sendSnapshotToWindows(snapshot);
  } catch (error) {
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
  const status = lifecycle.getStatus();
  let nextDelayMs = nodeHealthIntervalMs;
  if (status === 'failed') {
    scheduleRuntimeRecovery(nodeHealthRepairDelayMs);
    return;
  }
  if (nodeHealthCheckRunning || status !== 'running') {
    scheduleNodeHealthCheck();
    return;
  }

  nodeHealthCheckRunning = true;
  try {
    nextDelayMs = await ensureCurrentNodeUsable();
  } catch (error) {
    appendLog(`节点检查失败: ${formatError(error)}`);
    scheduleRuntimeRecovery(nodeHealthRepairDelayMs);
  } finally {
    nodeHealthCheckRunning = false;
    scheduleNodeHealthCheck(nextDelayMs);
  }
}

async function ensureCurrentNodeUsable(): Promise<number> {
  const settings = await settingsStore.read();
  if (settings.mode === 'direct' || settings.strategy === 'direct') return nodeHealthIntervalMs;

  const mihomoApi = createRuntimeMihomoApi({ secret: settings.controllerSecret });
  const currentNode = await mihomoApi.getCurrentNode();
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
  if (!selectedNode) {
    throw new Error('没有可用节点');
  }

  await settingsStore.update(
    isAutomaticStrategy(settings.strategy)
      ? { strategy: settings.strategy, selectedNode: null }
      : { strategy: 'manual', selectedNode }
  );
  await mihomoApi.closeConnections().catch((error) => appendLog(`关闭旧连接失败: ${formatError(error)}`));
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
        mihomoApi
          .getRuntimeStats()
          .catch(() => ({ activeConnections: 0, uploadTotal: 0, downloadTotal: 0 })),
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
    update: updateSnapshot,
    diagnostics: {
      lastError,
      logs: appLogs.slice(-80)
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

async function startProxy(): Promise<AppSnapshot> {
  await requireTrafficIdentity();
  await syncRemoteConfig();
  await startLifecycleWithRepairRetry();
  await activatePendingTrafficIdentity().catch((error) => {
    appendLog(`登记验证暂未完成: ${formatError(error)}`);
  });
  await syncRemoteConfig({ proxyUrl: getRuntimeTrafficProxyUrl(), restartIfRunning: true });
  trafficTracker.start();
  trafficReporter.start();
  clearLastError();
  scheduleNodeHealthCheck(0);
  return createSnapshot();
}

async function selectBestAutoNode(): Promise<AppSnapshot> {
  await requireTrafficIdentity();
  const settings = await settingsStore.update({ strategy: 'auto', selectedNode: null });
  if (lifecycle.getStatus() !== 'running') {
    await startProxy();
  }

  const mihomoApi = createRuntimeMihomoApi({ secret: settings.controllerSecret });
  const selectedNode = await mihomoApi.selectBestUsableNodeForStrategy('auto');
  if (!selectedNode) {
    throw new Error('没有可用节点');
  }

  await mihomoApi.closeConnections().catch((error) => appendLog(`关闭旧连接失败: ${formatError(error)}`));
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

async function startLifecycleWithRepairRetry(): Promise<void> {
  try {
    await lifecycle.start();
  } catch (error) {
    appendLog(`启动失败，自动修复后重试: ${formatError(error)}`);
    await lifecycle.repair().catch((repairError) => {
      appendLog(`自动修复失败: ${formatError(repairError)}`);
    });
    await lifecycle.start();
  }
}

async function stopProxy(): Promise<AppSnapshot> {
  await trafficTracker.flush().catch((error) => appendLog(`流量统计失败: ${formatError(error)}`));
  await trafficReporter.reportPending().catch((error) => appendLog(`流量上报失败: ${formatError(error)}`));
  trafficTracker.stop();
  await lifecycle.stop();
  return createSnapshot();
}

async function repairProxy(): Promise<AppSnapshot> {
  if (lifecycle.getStatus() === 'running') {
    const settings = await settingsStore.read();
    await trafficTracker.flush().catch((error) => appendLog(`流量统计失败: ${formatError(error)}`));
    await trafficReporter.reportPending().catch((error) => appendLog(`流量上报失败: ${formatError(error)}`));
    await createRuntimeMihomoApi({ secret: settings.controllerSecret }).closeConnections().catch(() => undefined);
  }
  trafficTracker.stop();
  await lifecycle.repair();
  clearSubscriptionRefreshTimer();
  clearLastError();
  return createSnapshot();
}

async function registerTrafficIdentity(input: Parameters<TrafficReporter['register']>[0]): Promise<AppSnapshot> {
  const wasRunning = lifecycle.getStatus() === 'running';
  let startedForRegistration = false;

  try {
    await trafficReporter.register(input, {
      proxyUrl: wasRunning ? getRuntimeTrafficProxyUrl() : undefined
    });
  } catch (error) {
    const settings = await settingsStore.read();
    if (!shouldRetryRegistrationViaProxy(error)) {
      throw error;
    }

    if (!wasRunning && settings.subscriptionUrl.trim()) {
      appendLog(`登记直连失败，尝试代理: ${formatError(error)}`);
      await startLifecycleWithRepairRetry();
      startedForRegistration = true;
      try {
        await trafficReporter.register(input, {
          proxyUrl: getRuntimeTrafficProxyUrl()
        });
      } catch (proxyError) {
        appendLog(`登记代理重试失败: ${formatError(proxyError)}`);
        if (isTrafficActivationAuthFailure(proxyError)) {
          throw proxyError;
        }
        await trafficStore.registerPendingIdentity(input);
      }
    } else {
      appendLog(`登记暂存，等待代理可用后重试: ${formatError(error)}`);
      await trafficStore.registerPendingIdentity(input);
    }
  }

  if (startedForRegistration) {
    await lifecycle.stop().catch((stopError) => appendLog(`登记回滚失败: ${formatError(stopError)}`));
  }
  if (lifecycle.getStatus() === 'running') {
    await syncRemoteConfig({ proxyUrl: getRuntimeTrafficProxyUrl(), restartIfRunning: true });
    trafficTracker.start();
    trafficReporter.start();
  }
  startRemoteConfigPolling();
  clearLastError();
  return createSnapshot();
}

async function activatePendingTrafficIdentity(): Promise<void> {
  const pending = await trafficStore.getPendingRegistration();
  if (!pending) return;

  try {
    await trafficReporter.register(pending, {
      proxyUrl: getRuntimeTrafficProxyUrl()
    });
    await syncRemoteConfig({ proxyUrl: getRuntimeTrafficProxyUrl(), restartIfRunning: true });
    appendLog('待验证登记已完成');
  } catch (error) {
    if (isTrafficActivationAuthFailure(error)) {
      await trafficStore.clearIdentity(formatError(error));
      throw error;
    }
    appendLog(`待验证登记暂未完成: ${formatError(error)}`);
  }
}

async function restartKernelAndApp(): Promise<AppSnapshot> {
  await lifecycle.restart();
  clearLastError();
  const snapshot = await createSnapshot();
  app.relaunch();
  cleanupFinished = true;
  isQuitting = true;
  app.exit(0);
  return snapshot;
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
  ipcMain.handle(ipcChannels.start, async () => {
    return withTrayRefresh(async () => {
      try {
        const snapshot = await startProxy();
        sendSnapshotToWindows(snapshot);
        return snapshot;
      } catch (error) {
        recordError('启动失败', error);
        throw error;
      }
    });
  });
  ipcMain.handle(ipcChannels.stop, async () => {
    return withTrayRefresh(async () => {
      try {
        const snapshot = await stopProxy();
        sendSnapshotToWindows(snapshot);
        return snapshot;
      } catch (error) {
        recordError('停止失败', error);
        throw error;
      }
    });
  });
  ipcMain.handle(ipcChannels.repair, async () => {
    return withTrayRefresh(async () => {
      try {
        const snapshot = await repairProxy();
        sendSnapshotToWindows(snapshot);
        return snapshot;
      } catch (error) {
        recordError('修复失败', error);
        throw error;
      }
    });
  });
  ipcMain.handle(ipcChannels.selectNode, async (_event, name: string) => {
    const settings = await settingsStore.read();
    if (lifecycle.getStatus() !== 'running') {
      await requireTrafficIdentity();
      await startLifecycleWithRepairRetry();
    }
    const mihomoApi = createMihomoApiClient({
      secret: settings.controllerSecret,
      controllerPort: runtimePorts.controllerPort
    });
    const selectedNode = await selectVerifiedManualNode(mihomoApi, name);
    await settingsStore.update({ strategy: 'manual', selectedNode });
    await mihomoApi.closeConnections().catch((error) => appendLog(`关闭旧连接失败: ${formatError(error)}`));
    scheduleNodeHealthCheck(0);
    return createSnapshot();
  });
  ipcMain.handle(ipcChannels.selectBestAutoNode, async () => {
    return withTrayRefresh(async () => {
      try {
        const snapshot = await selectBestAutoNode();
        sendSnapshotToWindows(snapshot);
        return snapshot;
      } catch (error) {
        recordError('自动选择节点失败', error);
        throw error;
      }
    });
  });
  ipcMain.handle(ipcChannels.selectStrategy, async (_event, strategy) => {
    const snapshot = await selectMihomoStrategy(
      {
        settingsStore,
        lifecycle,
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
        createMihomoApi: createRuntimeMihomoApi,
        createSnapshot
      },
      name
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
          createMihomoApi: createRuntimeMihomoApi,
          createSnapshot
        },
        {
          signal: controller.signal,
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
  ipcMain.handle(ipcChannels.testConnectivity, async (_event, key) => {
    return testConnectivity(
      {
        getMixedPort: () => runtimePorts.mixedPort,
        getControllerPort: () => runtimePorts.controllerPort,
        getControllerSecret: async () => (await settingsStore.read()).controllerSecret,
        isRunning: () => lifecycle.getStatus() === 'running'
      },
      key
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
  ipcMain.handle(ipcChannels.updateSubscription, async () => {
    return withTrayRefresh(async () => {
      await requireTrafficIdentity();
      const snapshot = await updateSubscriptionNodes({
        settingsStore,
        lifecycle,
        createMihomoApi: createRuntimeMihomoApi,
        createSnapshot
      });
      scheduleSubscriptionRefresh();
      return snapshot;
    });
  });
  ipcMain.handle(ipcChannels.saveSettings, async (_event, settings) => {
    return withTrayRefresh(async () => {
      const snapshot = await saveSubscriptionSettings(
        {
          settingsStore,
          lifecycle,
          createSnapshot
        },
        settings
      );
      scheduleSubscriptionRefresh();
      return snapshot;
    });
  });
  ipcMain.handle(ipcChannels.registerTrafficIdentity, async (_event, input) => {
    const snapshot = await registerTrafficIdentity(input);
    sendSnapshotToWindows(snapshot);
    return snapshot;
  });
  ipcMain.handle(ipcChannels.syncRemoteConfig, async () => {
    return withTrayRefresh(async () => {
      await requireTrafficIdentity();
      await syncRemoteConfig({
        proxyUrl: getRuntimeTrafficProxyUrl(),
        restartIfRunning: true,
        throwOnError: true
      });
      return createSnapshot();
    });
  });
  ipcMain.handle(ipcChannels.checkForUpdates, async () => {
    return checkForUpdatesNow(true);
  });
  ipcMain.handle(ipcChannels.installUpdate, async () => {
    return installDownloadedUpdate();
  });
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

  petDockTimer = setTimeout(() => {
    if (petDockBehavior?.kind !== 'side') return;
    setPetState(getSideBlinkState(petDockBehavior.side), 900);
  }, Math.min(petSideBlinkDelayMs, petSideSleepDelayMs - elapsed));
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
  if (!petWindow) {
    void createPetWindow();
    return;
  }

  petWindow.showInactive();
  setPetMousePassthrough(true);
  syncPetStateToRuntime();
  refreshTrayMenu();
}

function hidePetWindow() {
  if (!petFeatureEnabled) return;
  if (!petWindow) return;
  clearPetSequenceTimer();
  clearPetMoveTimer();
  setPetMousePassthrough(true);
  petWindow.hide();
  setPetState('idle');
  refreshTrayMenu();
}

function togglePetWindow() {
  if (!petFeatureEnabled) return;
  if (petWindow?.isVisible()) {
    hidePetWindow();
    return;
  }

  showPetWindow();
}

function querySchtasks(args: string[]): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('schtasks.exe', args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function runSchtasks(args: string[]): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await execFileAsync('schtasks.exe', args, { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function isLaunchAtLoginEnabled(): boolean {
  if (process.platform !== 'win32') {
    return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin;
  }

  return querySchtasks(['/Query', '/TN', startupTaskName]);
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
  clearLegacyLaunchAtLogin();

  if (process.platform !== 'win32') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled,
      path: process.execPath,
      args: enabled ? ['--hidden'] : []
    });
    return;
  }

  if (!enabled) {
    await runSchtasks(['/Delete', '/TN', startupTaskName, '/F']);
    return;
  }

  const taskCommand = `"${process.execPath}" --hidden`;
  const created = await runSchtasks([
    '/Create',
    '/TN',
    startupTaskName,
    '/SC',
    'ONLOGON',
    '/TR',
    taskCommand,
    '/RL',
    'HIGHEST',
    '/F'
  ]);

  if (!created) {
    throw new Error('无法写入 Windows 计划任务');
  }
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

async function migrateLegacyLaunchAtLogin() {
  if (process.platform !== 'win32') return;
  if (!isLegacyLaunchAtLoginEnabled() || isLaunchAtLoginEnabled()) return;

  try {
    await setLaunchAtLogin(true);
  } catch (error) {
    recordError('迁移开机自启失败', error);
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
      click: () => {
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

function dropPetToBottom(source: 'side' | 'top') {
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
    if (source === 'top') {
      playPetBottomSequence(['bottomDizzy', 'bottomAngry', 'bottomSleep']);
      return;
    }
    playPetBottomSequence(['bottomSleep']);
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

function playPetBottomSequence(states: DesktopPetState[]) {
  const [state, ...rest] = states;
  if (!state) return;

  setPetState(state);
  if (rest.length === 0) return;

  const holdMs = state === 'bottomDizzy' ? 1200 : 950;
  clearPetSequenceTimer();
  petSequenceTimer = setTimeout(() => {
    petSequenceTimer = undefined;
    playPetBottomSequence(rest);
  }, holdMs);
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
      clampPetBounds({
        x: petDragStart.windowX + nextCursor.x - petDragStart.cursorX,
        y: petDragStart.windowY + nextCursor.y - petDragStart.cursorY,
        ...petWindowSize
      }, area),
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
    } else {
      syncPetStateToRuntime();
    }
    return nextState;
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
            label: petWindow?.isVisible() ? '隐藏桌宠' : '显示桌宠',
            click: togglePetWindow
          }
        ]
      : []),
    {
      label: '网络修复',
      enabled: !trayBusy,
      submenu: [
        {
          label: '重启内核并重启软件',
          enabled: !trayBusy,
          click: () => {
            void runTrayAction('重启内核并重启软件', async () => {
              return restartKernelAndApp();
            });
          }
        },
        {
          label: '重型网络修复',
          enabled: !trayBusy,
          click: () => {
            void runTrayAction('重型网络修复', async () => {
              return repairProxy();
            });
          }
        }
      ]
    },
    { type: 'separator' },
    {
      label: '退出',
      enabled: !trayBusy,
      click: () => {
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
  const win = new BrowserWindow({
    width: 940,
    height: 620,
    minWidth: 900,
    minHeight: 600,
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
      sandbox: false
    }
  });
  mainWindow = win;

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
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  petWindow = win;
  win.setAlwaysOnTop(true, 'floating');
  setPetMousePassthrough(true, true);

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`pet preload failed: ${preloadPath}`, error);
  });

  win.webContents.on('context-menu', () => {
    showPetContextMenu();
  });

  win.once('ready-to-show', () => {
    win.showInactive();
    sendPetState();
    syncPetStateToRuntime();
    refreshTrayMenu();
  });

  win.on('closed', () => {
    if (petWindow === win) {
      petWindow = null;
    }
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

async function cleanupBeforeExit() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  stopRemoteConfigPolling();
  if (petFeatureEnabled) {
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
    if (lifecycle.getStatus() !== 'stopped') {
      await lifecycle.stop();
    }
  } finally {
    cleanupFinished = true;
    isQuitting = true;
    app.exit(0);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    await allocateRuntimePorts();
    registerIpc();
    setupAutoUpdates();
    createTray();
    void migrateLegacyLaunchAtLogin();
    void createWindow();
    startRemoteConfigPolling();
    if (petFeatureEnabled) {
      void createPetWindow();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  isQuitting = true;
  if (!cleanupFinished) {
    event.preventDefault();
    if (!cleanupStarted) {
      void cleanupBeforeExit();
    }
  }
});
