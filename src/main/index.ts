import { app, BrowserWindow, Menu, Tray, ipcMain } from 'electron';
import { join } from 'node:path';
import { createLifecycleController, type MihomoRuntime } from './lifecycle';
import { createMihomoApiClient } from './mihomo/api';
import { strategyLabels, strategyTargets } from './mihomo/config';
import { createMihomoRuntime } from './mihomo/process';
import { createSystemProxyAdapter } from './platform/systemProxy';
import { SettingsStore } from './storage/settings';
import {
  closeMihomoConnections,
  saveSubscriptionSettings,
  selectMihomoStrategy,
  setMihomoMode,
  testAllMihomoNodes,
  testMihomoNode,
  updateSubscriptionNodes
} from './appActions';
import { ipcChannels, type AppSnapshot, type StrategyGroup } from '../shared/ipc';

const appId = 'studio.youyu.proxy';
const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let cleanupFinished = false;
let cleanupStarted = false;
let isQuitting = false;

app.setName('YouYu');
if (process.platform === 'win32') {
  app.setAppUserModelId(appId);
}

const settingsStore = new SettingsStore(app.getPath('userData'));
const userDataDir = app.getPath('userData');
const mihomoBinaryPath = isDev
  ? join(process.cwd(), 'resources/mihomo/win-x64/mihomo.exe')
  : join(process.resourcesPath, 'mihomo/win-x64/mihomo.exe');
const windowIconPath = isDev
  ? join(process.cwd(), 'build/icon.png')
  : join(process.resourcesPath, 'assets/icon.png');
const mihomoRuntime: MihomoRuntime =
  process.platform === 'win32'
    ? createMihomoRuntime({
        binaryPath: mihomoBinaryPath,
        userDataDir,
        readSettings: () => settingsStore.read()
      })
    : {
        async start() {
          return undefined;
        },
        async stop() {
          return undefined;
        }
      };
const lifecycle = createLifecycleController({
  proxy: createSystemProxyAdapter({
    shouldManageProxy: async () => {
      const settings = await settingsStore.read();
      return settings.systemProxyEnabled;
    }
  }),
  mihomo: mihomoRuntime
});

async function createSnapshot(): Promise<AppSnapshot> {
  const settings = await settingsStore.read();
  const mihomoApi = createMihomoApiClient({ secret: settings.controllerSecret });
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
      allowLan: settings.allowLan
    },
    runtime,
    subscriptionUrl: settings.subscriptionUrl
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

function registerIpc() {
  ipcMain.handle(ipcChannels.getSnapshot, createSnapshot);
  ipcMain.handle(ipcChannels.start, async () => {
    await lifecycle.start();
    return createSnapshot();
  });
  ipcMain.handle(ipcChannels.stop, async () => {
    await lifecycle.stop();
    return createSnapshot();
  });
  ipcMain.handle(ipcChannels.repair, async () => {
    await lifecycle.repair();
    return createSnapshot();
  });
  ipcMain.handle(ipcChannels.selectNode, async (_event, name: string) => {
    const settings = await settingsStore.read();
    const mihomoApi = createMihomoApiClient({ secret: settings.controllerSecret });
    await mihomoApi.selectNode(name);
    await settingsStore.update({ strategy: 'manual' });
    return createSnapshot();
  });
  ipcMain.handle(ipcChannels.selectStrategy, async (_event, strategy) => {
    return selectMihomoStrategy(
      {
        settingsStore,
        lifecycle,
        createMihomoApi: createMihomoApiClient,
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
        createMihomoApi: createMihomoApiClient,
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
        createMihomoApi: createMihomoApiClient,
        createSnapshot
      },
      name
    );
  });
  ipcMain.handle(ipcChannels.testAllNodes, async () => {
    return testAllMihomoNodes({
      settingsStore,
      lifecycle,
      createMihomoApi: createMihomoApiClient,
      createSnapshot
    });
  });
  ipcMain.handle(ipcChannels.closeConnections, async () => {
    return closeMihomoConnections({
      settingsStore,
      lifecycle,
      createMihomoApi: createMihomoApiClient,
      createSnapshot
    });
  });
  ipcMain.handle(ipcChannels.updateSubscription, async () => {
    return updateSubscriptionNodes({
      settingsStore,
      lifecycle,
      createMihomoApi: createMihomoApiClient,
      createSnapshot
    });
  });
  ipcMain.handle(ipcChannels.saveSettings, async (_event, settings) => {
    return saveSubscriptionSettings(
      {
        settingsStore,
        lifecycle,
        createSnapshot
      },
      settings
    );
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

function refreshTrayMenu() {
  if (!tray) return;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 YouYu',
        click: showMainWindow
      },
      {
        label: '停止代理',
        click: () => {
          void lifecycle.stop().catch((error) => console.error('stop from tray failed', error));
        }
      },
      {
        label: '修复网络',
        click: () => {
          void lifecycle.repair().catch((error) => console.error('repair from tray failed', error));
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          void cleanupBeforeExit();
        }
      }
    ])
  );
}

function createTray() {
  if (tray || process.platform !== 'win32') return;

  tray = new Tray(windowIconPath);
  tray.setToolTip('YouYu');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  refreshTrayMenu();
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 620,
    title: 'YouYu',
    icon: windowIconPath,
    show: false,
    skipTaskbar: false,
    autoHideMenuBar: true,
    backgroundColor: '#fbf9ff',
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
    win.show();
    win.focus();
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

async function cleanupBeforeExit() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  try {
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

  app.whenReady().then(() => {
    registerIpc();
    createTray();
    void createWindow();

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
