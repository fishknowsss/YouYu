import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('update install entry points', () => {
  it('uses the same extracted install handler in easy and advanced interfaces', async () => {
    const [controllerSource, updateActionsSource] = await Promise.all([
      readFile('src/renderer/hooks/useAppController.ts', 'utf8'),
      readFile('src/renderer/appUpdateActions.ts', 'utf8')
    ]);

    expect(updateActionsSource).toContain('const handleInstallUpdate =');
    expect(updateActionsSource).toContain('installUpdate: () => handleInstallUpdate()');
    expect(updateActionsSource).toContain(
      'installSettingsUpdate: () => handleInstallUpdate(dependencies.setSettingsMessage)'
    );
    expect(controllerSource).toContain('createUpdateActions<AppApi, AppSnapshot>');
    expect(controllerSource).toContain('installUpdate: updateActions.installUpdate');
    expect(controllerSource).toContain('installSettingsUpdate: updateActions.installSettingsUpdate');
  });

  it('keeps an installer launch failure from closing the app', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');

    expect(source).toContain('recoverFromUpdateInstallerLaunchFailure');
    expect(source).toContain('if (updateInstallerLaunchFailed)');
    expect(source).toContain('event.preventDefault();');
  });

  it('uses the controlled UAC launcher before quitting the current app', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const install = source.slice(
      source.indexOf('async function installDownloadedUpdate'),
      source.indexOf('function recoverFromUpdateInstallerLaunchFailure')
    );

    expect(install).toContain('await launchDownloadedUpdateInstaller({');
    expect(install).toContain('updateInstallerLaunchStarted = true');
    expect(install).toContain('app.quit()');
    expect(install).not.toContain('autoUpdater.quitAndInstall');
  });
});
