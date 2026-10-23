import { BrowserWindow } from 'electron';
import { calculateMainWindowMetrics, type WindowSize } from './windowSizing';

export function createMainWindow(
  display: { size: WindowSize; workAreaSize: WindowSize },
  paths: { preload: string; icon?: string }
): BrowserWindow {
  const metrics = calculateMainWindowMetrics(display.size, display.workAreaSize);
  const win = new BrowserWindow({
    width: metrics.width,
    height: metrics.height,
    minWidth: metrics.minWidth,
    minHeight: metrics.minHeight,
    useContentSize: true,
    title: 'YouYu',
    icon: paths.icon,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f5f0fb', symbolColor: '#4c3f5d', height: 30 },
    show: false,
    skipTaskbar: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f0fb',
    webPreferences: {
      // Navigation uses the default page zoom, including the first rendered frame.
      zoomFactor: metrics.zoomFactor,
      preload: paths.preload,
      additionalArguments: ['--youyu-window-role=main'],
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: true
    }
  });
  // Restore the window's scale after navigation, including an existing origin zoom.
  win.webContents.on('dom-ready', () => win.webContents.setZoomFactor(metrics.zoomFactor));
  return win;
}
