import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('packaged preload path', () => {
  it('loads the electron-vite preload output file', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const config = await readFile('electron.vite.config.ts', 'utf8');
    const html = await readFile('index.html', 'utf8');
    const builder = await readFile('electron-builder.yml', 'utf8');
    const installer = await readFile('build/installer.nsh', 'utf8');

    expect(config).toContain("format: 'cjs'");
    expect(config).toContain("entryFileNames: '[name].cjs'");
    expect(source).toContain('../preload/index.cjs');
    expect(source).not.toContain('../preload/index.mjs');
    expect(source).toContain('sandbox: true');
    expect(source).not.toContain('sandbox: false');
    expect(source).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))");
    expect(source).toContain("window.webContents.on('will-navigate'");
    expect(source).toContain("window.webContents.on('will-attach-webview'");
    expect(source).toContain('untrusted IPC sender');
    expect(source).toContain('await systemProxy.restore()');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("object-src 'none'");
    expect(builder).toContain('requestedExecutionLevel: asInvoker');
    expect(builder).toContain('perMachine: true');
    expect(installer).not.toContain('SetShellVarContext current');
  });
});
