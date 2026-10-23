import { app, BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMainWindow } from '../../src/main/mainWindow';
import { calculateMainWindowMetrics } from '../../src/main/windowSizing';

app.on('window-all-closed', () => undefined);
void run();

async function run() {
  const profile = app.getPath('userData');
  const windows: BrowserWindow[] = [];
  let exitCode = 0;
  try {
    await app.whenReady();
    const html = join(profile, 'index.html');
    const preload = join(profile, 'preload.cjs');
    await writeFile(preload, '');
    await writeFile(
      html,
      '<!doctype html><style>html,body{width:100%;height:100%;margin:0;overflow:hidden}body{min-width:900px;min-height:600px}main{display:grid;place-items:center;width:100%;height:100%}button{width:204px;height:226px}</style><main><button>连接</button></main>'
    );
    const nativeDisplay = screen.getPrimaryDisplay();
    const displays = [
      { size: { width: 1024, height: 576 }, workAreaSize: { width: 1024, height: 552 } },
      { size: { width: 1536, height: 864 }, workAreaSize: { width: 1536, height: 824 } },
      { size: { width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1040 } },
      { size: { width: 2048, height: 1152 }, workAreaSize: { width: 2048, height: 1112 } },
      { size: { width: 2560, height: 1440 }, workAreaSize: { width: 2560, height: 1400 } },
      { size: { width: 1920, height: 1080 }, workAreaSize: { width: 1200, height: 500 } },
      nativeDisplay
    ];
    for (const display of displays) {
      const metrics = calculateMainWindowMetrics(display.size, display.workAreaSize);
      const win = createMainWindow(display, { preload });
      windows.push(win);
      const ready = new Promise<void>((resolve) => win.once('ready-to-show', resolve));
      await win.loadFile(html);
      await ready;
      assert.deepEqual(win.getContentSize(), [metrics.width, metrics.height], 'content matches the calculated size');
      await check(win, metrics.zoomFactor, 'first frame');
      const auxiliary = new BrowserWindow({ width: 180, height: 180, show: false });
      windows.push(auxiliary);
      await auxiliary.loadFile(html, { query: { view: 'pet' } });
      await check(win, metrics.zoomFactor, 'with auxiliary window');
      assert.equal(auxiliary.webContents.getZoomFactor(), 1, 'auxiliary keeps its own scale');
      await win.loadFile(html);
      await check(win, metrics.zoomFactor, 'reload');
      assert.equal(auxiliary.webContents.getZoomFactor(), 1, 'main reload must not change auxiliary scale');
      if (display === nativeDisplay) {
        const workArea = nativeDisplay.workArea;
        const bounds = win.getBounds();
        assert(bounds.x >= workArea.x && bounds.y >= workArea.y, 'window starts inside the display');
        assert(bounds.x + bounds.width <= workArea.x + workArea.width, 'window fits the display width');
        assert(bounds.y + bounds.height <= workArea.y + workArea.height, 'window fits the display height');
      }
      console.log(`Window ${metrics.width}x${metrics.height}: first frame, auxiliary and reload passed`);
      auxiliary.destroy();
      win.destroy();
    }
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    app.exit(exitCode);
  }
}

async function check(win: BrowserWindow, zoom: number, phase: string) {
  assert(
    Math.abs(win.webContents.getZoomFactor() - zoom) < 0.001,
    `${phase}: page zoom ${win.webContents.getZoomFactor()} must match window scale ${zoom}`
  );
  const layout = await win.webContents.executeJavaScript(`({
    width: innerWidth, height: innerHeight, bodyWidth: document.body.clientWidth,
    button: document.querySelector('button').getBoundingClientRect().toJSON()
  })`);
  assert(layout.width >= 899 && layout.height >= 599, `${phase}: 900x600 CSS viewport must fit`);
  assert(layout.bodyWidth <= layout.width + 1, `${phase}: page must not be clipped`);
  assert(Math.abs(layout.button.x + layout.button.width / 2 - layout.width / 2) <= 1, `${phase}: button centered`);
}
