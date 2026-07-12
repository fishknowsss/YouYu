import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Windows upgrade installer safety', () => {
  it('uses a controlled shutdown before its ownership-guarded force-close fallback', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8');
    const controlledShutdown = installer.indexOf('--shutdown-for-install');
    const restoreOwnedProxy = installer.indexOf('YouYuRestoreOwnedProxyBeforeForceClose');
    const forceClose = installer.indexOf('Stop-Process -Force');

    expect(controlledShutdown).toBeGreaterThan(-1);
    expect(restoreOwnedProxy).toBeGreaterThan(controlledShutdown);
    expect(forceClose).toBeGreaterThan(restoreOwnedProxy);
    expect(installer).toContain('system-proxy-ownership.json');
    expect(installer).toContain('appliedFields');
    expect(installer).toContain('InternetSetOption');
    expect(installer).toContain('FromBase64String');
    expect(installer.indexOf('Remove-Item -LiteralPath $$path')).toBeLessThan(
      installer.indexOf('Add-Type -TypeDefinition')
    );
    expect(installer).toContain('IfSilent YouYuCloseFailedSilent');
    expect(installer).not.toContain('-ExecutionPolicy Bypass');
  });

  it('lets the running application restore its proxy before exiting for an install', async () => {
    const main = await readFile('src/main/index.ts', 'utf8');
    const shutdownHandlerStart = main.indexOf("commandLine.includes('--shutdown-for-install')");
    const shutdownHandler = main.slice(shutdownHandlerStart, shutdownHandlerStart + 320);

    expect(main).toContain("process.argv.includes('--shutdown-for-install')");
    expect(shutdownHandlerStart).toBeGreaterThan(-1);
    expect(shutdownHandler).toContain('void cleanupBeforeExit();');
    expect(shutdownHandler.indexOf('void cleanupBeforeExit();')).toBeLessThan(
      shutdownHandler.indexOf('showMainWindow();')
    );
  });
});
