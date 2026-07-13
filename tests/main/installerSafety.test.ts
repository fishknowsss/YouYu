import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Windows upgrade installer safety', () => {
  it('uses a controlled shutdown before its ownership-guarded force-close fallback', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8');
    const restoreScript = await readFile('build/restore-owned-proxy.ps1', 'utf8');
    const processScript = await readFile('build/manage-installed-process.ps1', 'utf8');
    const controlledShutdown = installer.indexOf('--shutdown-for-install');
    const restoreOwnedProxy = installer.indexOf('YouYuRestoreOwnedProxyBeforeForceClose');
    const forceClose = installer.indexOf('-Action Force');
    const restoreGuard = installer.slice(restoreOwnedProxy, forceClose);
    const closeFunction = installer.slice(
      installer.indexOf('Function YouYuCloseRunningAppBeforeInstall'),
      installer.indexOf('Function YouYuRestoreOwnedProxyBeforeForceClose')
    );

    expect(controlledShutdown).toBeGreaterThan(-1);
    expect(restoreOwnedProxy).toBeGreaterThan(controlledShutdown);
    expect(forceClose).toBeGreaterThan(restoreOwnedProxy);
    expect(restoreGuard).toContain('${If} $0 != 0');
    expect(restoreGuard).toContain('Goto YouYuCloseFailed');
    expect(restoreScript).toContain('system-proxy-ownership.json');
    expect(installer).toContain('restore-owned-proxy.ps1');
    expect(installer).toContain('manage-installed-process.ps1');
    expect(installer).toContain('-ExecutionPolicy RemoteSigned');
    expect(installer).toContain('-File "$PLUGINSDIR\\YouYuRestoreOwnedProxy.ps1"');
    expect(restoreScript).toContain("Get-RequiredProperty $state 'appliedFields'");
    expect(restoreScript).toContain('$serverWasReplaced');
    expect(restoreScript).toContain('$currentValue -ne $appliedValue');
    expect(restoreScript).toContain('InternetSetOption');
    expect(restoreScript).toContain('if (-not $settingsChanged -or -not $settingsRefreshed)');
    expect(restoreScript).not.toContain('if ($restoredAnyField)');
    expect(restoreScript.lastIndexOf('Remove-Item -LiteralPath $statePath')).toBeGreaterThan(
      restoreScript.indexOf('Add-Type -TypeDefinition')
    );
    expect(installer).toContain('IfSilent YouYuCloseFailedSilent');
    expect(processScript).toContain("Get-Process -Name 'YouYu'");
    expect(processScript).toContain('[IO.Path]::GetFullPath($_.Path) -ieq $expectedPath');
    expect(processScript).toContain('$matches | Stop-Process -Force');
    expect(processScript).toContain('[Console]::Error.WriteLine($_.Exception.Message)');
    expect(processScript).toContain('exit 2');
    expect(closeFunction).toContain('${If} $0 == 1');
    expect(closeFunction).toContain('${ElseIf} $0 != 0');
    expect(closeFunction).toContain('${ElseIf} $0 != 1');
    expect(closeFunction).toContain('${If} $0 != 1');
    expect(installer).not.toContain('Get-Process -Name YouYu');
    expect(installer).not.toContain('-ExecutionPolicy Bypass');
    expect(restoreScript).not.toContain('-ExecutionPolicy Bypass');
  });

  it('removes the app startup task during uninstall', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8');
    const uninstallMacro = installer.slice(
      installer.indexOf('!macro customUnInstall'),
      installer.indexOf('!macroend', installer.indexOf('!macro customUnInstall'))
    );

    expect(uninstallMacro).toContain('${IfNot} ${isUpdated}');
    expect(uninstallMacro).toContain('schtasks.exe');
    expect(uninstallMacro).toContain('/Delete /TN "YouYu" /F');
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
