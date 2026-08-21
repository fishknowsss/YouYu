import { contextBridge, ipcRenderer } from 'electron';
import {
  ipcChannels,
  type DesktopNoticeApi,
  type DesktopPetApi,
  type RendererWindowApi,
  type RendererWindowRole,
  type YouYuApi
} from '../shared/ipc';

type IpcRendererBridge = Pick<typeof ipcRenderer, 'invoke' | 'on' | 'off'>;

function subscribe<T>(renderer: IpcRendererBridge, channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  renderer.on(channel, handler);
  return () => renderer.off(channel, handler);
}

function createMainWindowApi(renderer: IpcRendererBridge): YouYuApi {
  return {
    getSnapshot: () => renderer.invoke(ipcChannels.getSnapshot),
    onSnapshotUpdated: (listener) => subscribe(renderer, ipcChannels.snapshotUpdated, listener),
    onPetStateUpdated: (listener) => subscribe(renderer, ipcChannels.petStateUpdated, listener),
    wavePet: () => renderer.invoke(ipcChannels.wavePet),
    startPetDrag: () => renderer.invoke(ipcChannels.startPetDrag),
    stopPetDrag: (moved) => renderer.invoke(ipcChannels.stopPetDrag, moved),
    setPetMousePassthrough: (passthrough) => renderer.invoke(ipcChannels.setPetMousePassthrough, passthrough),
    showMainWindow: () => renderer.invoke(ipcChannels.showMainWindow),
    start: (request) => renderer.invoke(ipcChannels.start, request),
    stop: (request) => renderer.invoke(ipcChannels.stop, request),
    repair: (request) => renderer.invoke(ipcChannels.repair, request),
    selectNode: (name) => renderer.invoke(ipcChannels.selectNode, name),
    selectBestAutoNode: (request) => renderer.invoke(ipcChannels.selectBestAutoNode, request),
    selectStrategy: (strategy) => renderer.invoke(ipcChannels.selectStrategy, strategy),
    setMode: (mode) => renderer.invoke(ipcChannels.setMode, mode),
    testNode: (name) => renderer.invoke(ipcChannels.testNode, name),
    testAllNodes: () => renderer.invoke(ipcChannels.testAllNodes),
    cancelNodeTests: () => renderer.invoke(ipcChannels.cancelNodeTests),
    testConnectivity: (key, request) => renderer.invoke(ipcChannels.testConnectivity, key, request),
    testAllConnectivity: () => renderer.invoke(ipcChannels.testAllConnectivity),
    closeConnections: () => renderer.invoke(ipcChannels.closeConnections),
    updateSubscription: (request) => renderer.invoke(ipcChannels.updateSubscription, request),
    saveSettings: (settings, intent, request) => renderer.invoke(ipcChannels.saveSettings, settings, intent, request),
    registerTrafficIdentity: (input) => renderer.invoke(ipcChannels.registerTrafficIdentity, input),
    acknowledgeUserNotice: (revision) => renderer.invoke(ipcChannels.acknowledgeUserNotice, revision),
    wakeRemoteConfig: () => renderer.invoke(ipcChannels.wakeRemoteConfig),
    syncRemoteConfig: (request) => renderer.invoke(ipcChannels.syncRemoteConfig, request),
    exportDiagnostics: () => renderer.invoke(ipcChannels.exportDiagnostics),
    cancelOperation: (requestId) => renderer.invoke(ipcChannels.cancelOperation, requestId),
    checkForUpdates: () => renderer.invoke(ipcChannels.checkForUpdates),
    installUpdate: () => renderer.invoke(ipcChannels.installUpdate)
  };
}

function createDesktopNoticeApi(renderer: IpcRendererBridge): DesktopNoticeApi {
  return {
    getSnapshot: () => renderer.invoke(ipcChannels.getDesktopNoticeSnapshot),
    onSnapshotUpdated: (listener) => subscribe(renderer, ipcChannels.desktopNoticeUpdated, listener),
    acknowledgeUserNotice: (revision) => renderer.invoke(ipcChannels.acknowledgeDesktopNotice, revision)
  };
}

function createDesktopPetApi(renderer: IpcRendererBridge): DesktopPetApi {
  return {
    onPetStateUpdated: (listener) => subscribe(renderer, ipcChannels.petStateUpdated, listener),
    wavePet: () => renderer.invoke(ipcChannels.wavePet),
    startPetDrag: () => renderer.invoke(ipcChannels.startPetDrag),
    stopPetDrag: (moved) => renderer.invoke(ipcChannels.stopPetDrag, moved),
    setPetMousePassthrough: (passthrough) => renderer.invoke(ipcChannels.setPetMousePassthrough, passthrough),
    showMainWindow: () => renderer.invoke(ipcChannels.showMainWindow)
  };
}

export function createWindowApi(
  role: RendererWindowRole,
  renderer: IpcRendererBridge = ipcRenderer
): RendererWindowApi {
  if (role === 'notice') return createDesktopNoticeApi(renderer);
  if (role === 'pet') return createDesktopPetApi(renderer);
  return createMainWindowApi(renderer);
}

export function resolveWindowRole(args: readonly string[]): RendererWindowRole {
  const prefix = '--youyu-window-role=';
  const roles = args.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (roles.length !== 1 || !['main', 'notice', 'pet'].includes(roles[0] ?? '')) {
    throw new Error('invalid YouYu renderer window role');
  }
  return roles[0] as RendererWindowRole;
}

contextBridge.exposeInMainWorld('youyu', createWindowApi(resolveWindowRole(process.argv)));
