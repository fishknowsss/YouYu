import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels, type DesktopPetState, type YouYuApi } from '../shared/ipc';

const api: YouYuApi = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.getSnapshot),
  onSnapshotUpdated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.snapshotUpdated, handler);
    return () => ipcRenderer.off(ipcChannels.snapshotUpdated, handler);
  },
  onPetStateUpdated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopPetState) => {
      listener(state);
    };
    ipcRenderer.on(ipcChannels.petStateUpdated, handler);
    return () => ipcRenderer.off(ipcChannels.petStateUpdated, handler);
  },
  wavePet: () => ipcRenderer.invoke(ipcChannels.wavePet),
  startPetDrag: () => ipcRenderer.invoke(ipcChannels.startPetDrag),
  stopPetDrag: (moved) => ipcRenderer.invoke(ipcChannels.stopPetDrag, moved),
  setPetMousePassthrough: (passthrough) => ipcRenderer.invoke(ipcChannels.setPetMousePassthrough, passthrough),
  showMainWindow: () => ipcRenderer.invoke(ipcChannels.showMainWindow),
  start: (request) => ipcRenderer.invoke(ipcChannels.start, request),
  stop: (request) => ipcRenderer.invoke(ipcChannels.stop, request),
  repair: (request) => ipcRenderer.invoke(ipcChannels.repair, request),
  selectNode: (name) => ipcRenderer.invoke(ipcChannels.selectNode, name),
  selectBestAutoNode: (request) => ipcRenderer.invoke(ipcChannels.selectBestAutoNode, request),
  selectStrategy: (strategy) => ipcRenderer.invoke(ipcChannels.selectStrategy, strategy),
  setMode: (mode) => ipcRenderer.invoke(ipcChannels.setMode, mode),
  testNode: (name) => ipcRenderer.invoke(ipcChannels.testNode, name),
  testAllNodes: () => ipcRenderer.invoke(ipcChannels.testAllNodes),
  cancelNodeTests: () => ipcRenderer.invoke(ipcChannels.cancelNodeTests),
  testConnectivity: (key, request) => ipcRenderer.invoke(ipcChannels.testConnectivity, key, request),
  testAllConnectivity: () => ipcRenderer.invoke(ipcChannels.testAllConnectivity),
  closeConnections: () => ipcRenderer.invoke(ipcChannels.closeConnections),
  updateSubscription: (request) => ipcRenderer.invoke(ipcChannels.updateSubscription, request),
  saveSettings: (settings, request) => ipcRenderer.invoke(ipcChannels.saveSettings, settings, request),
  registerTrafficIdentity: (input) => ipcRenderer.invoke(ipcChannels.registerTrafficIdentity, input),
  syncRemoteConfig: (request) => ipcRenderer.invoke(ipcChannels.syncRemoteConfig, request),
  exportDiagnostics: () => ipcRenderer.invoke(ipcChannels.exportDiagnostics),
  cancelOperation: (requestId) => ipcRenderer.invoke(ipcChannels.cancelOperation, requestId),
  checkForUpdates: () => ipcRenderer.invoke(ipcChannels.checkForUpdates),
  installUpdate: () => ipcRenderer.invoke(ipcChannels.installUpdate)
};

contextBridge.exposeInMainWorld('youyu', api);
