import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('update install entry points', () => {
  it('uses the same install handler in easy and advanced interfaces', async () => {
    const source = await readFile('src/renderer/hooks/useAppController.ts', 'utf8');

    expect(source).toContain('const handleInstallUpdate = useCallback(');
    expect(source).toContain('const installUpdate = useCallback(() => handleInstallUpdate()');
    expect(source).toContain('() => handleInstallUpdate(setSettingsMessage)');
    expect(source).toContain('messageSink');
  });

  it('keeps an installer launch failure from closing the app', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');

    expect(source).toContain('recoverFromUpdateInstallerLaunchFailure');
    expect(source).toContain('if (updateInstallerLaunchFailed)');
    expect(source).toContain('event.preventDefault();');
  });

  it('installs an in-app Windows update silently and starts YouYu again', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const install = source.slice(
      source.indexOf('async function installDownloadedUpdate'),
      source.indexOf('function recoverFromUpdateInstallerLaunchFailure')
    );

    expect(install).toContain('autoUpdater.quitAndInstall(true, true)');
    expect(install).not.toContain('autoUpdater.quitAndInstall(false, true)');
  });
});
