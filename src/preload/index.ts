import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels, type YouYuApi } from '../shared/ipc';

const api: YouYuApi = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.getSnapshot),
  onSnapshotUpdated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => {
      listener(snapshot);
    };
    ipcRenderer.on(ipcChannels.snapshotUpdated, handler);
    return () => ipcRenderer.off(ipcChannels.snapshotUpdated, handler);
  },
  start: () => ipcRenderer.invoke(ipcChannels.start),
  stop: () => ipcRenderer.invoke(ipcChannels.stop),
  repair: () => ipcRenderer.invoke(ipcChannels.repair),
  selectNode: (name) => ipcRenderer.invoke(ipcChannels.selectNode, name),
  selectStrategy: (strategy) => ipcRenderer.invoke(ipcChannels.selectStrategy, strategy),
  setMode: (mode) => ipcRenderer.invoke(ipcChannels.setMode, mode),
  testNode: (name) => ipcRenderer.invoke(ipcChannels.testNode, name),
  testAllNodes: () => ipcRenderer.invoke(ipcChannels.testAllNodes),
  closeConnections: () => ipcRenderer.invoke(ipcChannels.closeConnections),
  updateSubscription: () => ipcRenderer.invoke(ipcChannels.updateSubscription),
  saveSettings: (settings) => ipcRenderer.invoke(ipcChannels.saveSettings, settings)
};

contextBridge.exposeInMainWorld('youyu', api);
