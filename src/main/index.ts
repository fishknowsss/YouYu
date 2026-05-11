import { app, BrowserWindow, Menu, Tray, ipcMain, screen, type Rectangle } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { createLifecycleController, type MihomoRuntime } from './lifecycle';
import { testAllConnectivity, testConnectivity } from './connectivity';
import { createMihomoApiClient } from './mihomo/api';
import { strategyLabels, strategyTargets } from './mihomo/config';
import { createMihomoRuntime } from './mihomo/process';
import { createSystemProxyAdapter } from './platform/systemProxy';
import { SettingsStore } from './storage/settings';
import { TrafficReporter } from './traffic/reporter';
import { TrafficStore } from './traffic/store';
import { TrafficTracker } from './traffic/tracker';
import {
  closeMihomoConnections,
  saveSubscriptionSettings,
  selectMihomoStrategy,
  setMihomoMode,
  testAllMihomoNodes,
  testMihomoNode,
  updateSubscriptionNodes
} from './appActions';
import { ipcChannels, type AppSnapshot, type DesktopPetState, type StrategyGroup } from '../shared/ipc';

declare const __YOUYU_DISABLE_PET__: boolean;

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
let subscriptionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
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
let lastError: string | undefined;
const appLogs: string[] = [];
const petFeatureEnabled = !__YOUYU_DISABLE_PET__;
const petWindowSize = {
  width: 190,
  height: 212
};
const petDragFrameMs = 16;

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
const settingsStore = new SettingsStore(app.getPath('userData'), {
  defaultSubscriptionUrl: readDefaultSubscriptionUrl(defaultSubscriptionPath)
});
const trafficStore = new TrafficStore(app.getPath('userData'));
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
    return createRuntimeMihomoApi({ secret: settings.controllerSecret }).getRuntimeStats();
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
        getPorts: allocateRuntimePorts,
        logLine: appendLog,
        onUnexpectedExit: (reason) => {
          recordError('mihomo 异常退出', reason);
          lifecycle.markRuntimeExited?.(reason);
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
  return readOptionalText(path);
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
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${message}`;
  appLogs.push(line);
  if (appLogs.length > 200) {
    appLogs.splice(0, appLogs.length - 200);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function recordError(context: string, error: unknown) {
  lastError = `${context}: ${formatError(error)}`;
  appendLog(lastError);
}

function getRuntimeTrafficProxyUrl(): string | undefined {
  return lifecycle?.getStatus() === 'running' ? `http://127.0.0.1:${runtimePorts.mixedPort}` : undefined;
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
  onStatusChange: () => {
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

  return {
    status: lifecycle.getStatus(),
    currentNode,
    nodes,
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
  await lifecycle.start();
  await activatePendingTrafficIdentity();
  trafficTracker.start();
  trafficReporter.start();
  clearLastError();
  return createSnapshot();
}

async function requireTrafficIdentity(): Promise<void> {
  const snapshot = await trafficStore.getSnapshot();
  if (!snapshot.identity) {
    throw new Error('traffic identity required');
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
      await lifecycle.start();
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
    trafficTracker.start();
    trafficReporter.start();
  }
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
    await settingsStore.update({ strategy: 'manual', selectedNode: name });
    if (lifecycle.getStatus() !== 'running') {
      await requireTrafficIdentity();
      await lifecycle.start();
    }
    const mihomoApi = createMihomoApiClient({
      secret: settings.controllerSecret,
      controllerPort: runtimePorts.controllerPort
    });
    await mihomoApi.selectNode(name);
    return createSnapshot();
  });
  ipcMain.handle(ipcChannels.selectStrategy, async (_event, strategy) => {
    return selectMihomoStrategy(
      {
        settingsStore,
        lifecycle,
        createMihomoApi: createRuntimeMihomoApi,
        createSnapshot
      },
      strategy
    );
  });
  ipcMain.handle(ipcChannels.setMode, async (_event, mode) => {
    return setMihomoMode(
      {
        settingsStore,
        lifecycle,
        createMihomoApi: createRuntimeMihomoApi,
        createSnapshot
      },
      mode
    );
  });
  ipcMain.handle(ipcChannels.testNode, async (_event, name: string) => {
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
    return testAllMihomoNodes({
      settingsStore,
      lifecycle,
      createMihomoApi: createRuntimeMihomoApi,
      createSnapshot
    });
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
  syncPetStateToRuntime();
  refreshTrayMenu();
}

function hidePetWindow() {
  if (!petFeatureEnabled) return;
  if (!petWindow) return;
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
  const distances = [
    { state: 'edgeLeft' as const, distance: Math.abs(bounds.x - area.x) },
    {
      state: 'edgeRight' as const,
      distance: Math.abs(area.x + area.width - (bounds.x + bounds.width))
    }
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

function applyPetWindowShape(win: BrowserWindow) {
  void win;
}

async function dockPetToBottomRight() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const area = screen.getDisplayMatching(petWindow.getBounds()).workArea;
  const bounds = getBottomRightEdgeBounds(area);
  petWindow.setBounds(bounds, false);
  savePetBounds(bounds);
  setPetState('edgeRight');
}

function startPetDrag() {
  if (!petWindow || petDragTimer) return;

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
  applyPetWindowShape(win);

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
  if (petFeatureEnabled) {
    stopPetDrag({ settle: false });
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
    createTray();
    void migrateLegacyLaunchAtLogin();
    void createWindow();
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
