import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('update and exit lifecycle safety', () => {
  it('finishes a freshness check before committing to the downloaded installer handoff', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const install = source.slice(
      source.indexOf('async function installDownloadedUpdate'),
      source.indexOf('function recoverFromUpdateInstallerLaunchFailure')
    );

    expect(install).toContain('await updateCoordinator.prepareInstall()');
    expect(install.indexOf('await updateCoordinator.prepareInstall()')).toBeLessThan(
      install.indexOf('updateInstallerLaunchPending = true')
    );
    expect(install.indexOf('await updateCoordinator.prepareInstall()')).toBeLessThan(
      install.indexOf('launchDownloadedUpdateInstaller({ installerPath, handoff })')
    );
  });

  it('suspends restart work before update preparation begins', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const install = source.slice(
      source.indexOf('async function installDownloadedUpdate'),
      source.indexOf('function recoverFromUpdateInstallerLaunchFailure')
    );

    expect(install.indexOf('updateInstallerLaunchPending = true')).toBeLessThan(
      install.indexOf('await prepareForUpdateInstall()')
    );
    expect(install.indexOf('lifecycle.suspendStarts()')).toBeLessThan(
      install.indexOf('await prepareForUpdateInstall()')
    );
    expect(install.indexOf("status: 'installing'")).toBeLessThan(install.indexOf('await prepareForUpdateInstall()'));
    expect(install.indexOf('message: updateInstallingMessage')).toBeLessThan(
      install.indexOf('await prepareForUpdateInstall()')
    );
  });

  it('resumes lifecycle starts after installer preparation or launch failure', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const recovery = source.slice(
      source.indexOf('function recoverFromUpdateInstallFailure'),
      source.indexOf('async function prepareForUpdateInstall')
    );

    expect(recovery).toContain('lifecycle.resumeStarts()');
    expect(recovery).toContain('updateInstallerLaunchFailed = beforeQuitWasObserved');
    expect(recovery).toContain(
      "setUpdateSnapshot({ status: 'downloaded', message, failureKind: 'installer-launch-failed' })"
    );
  });

  it('does not launch a deferred installer after recovery cancels that install attempt', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const install = source.slice(
      source.indexOf('async function installDownloadedUpdate'),
      source.indexOf('function recoverFromUpdateInstallerLaunchFailure')
    );
    const deferredLaunch = install.slice(install.indexOf('deferUpdateInstallerLaunch'));

    expect(deferredLaunch).toContain('!updateInstallerLaunchPending');
    expect(deferredLaunch).toContain('updateInstallAttempt !== installAttempt');
    expect(deferredLaunch.indexOf('updateInstallAttempt !== installAttempt')).toBeLessThan(
      deferredLaunch.indexOf('launchDownloadedUpdateInstaller({ installerPath, handoff })')
    );
    expect(deferredLaunch.indexOf('updateInstallerLaunchStarted = true')).toBeLessThan(
      deferredLaunch.indexOf('app.quit()')
    );
    expect(deferredLaunch.indexOf('cleanupFinished = true')).toBeLessThan(deferredLaunch.indexOf('app.quit()'));
    expect(deferredLaunch.indexOf('isQuitting = true')).toBeLessThan(deferredLaunch.indexOf('app.quit()'));
    expect(deferredLaunch.indexOf('launchDownloadedUpdateInstaller({ installerPath, handoff })')).toBeLessThan(
      deferredLaunch.indexOf('updateInstallerLaunchStarted = true')
    );
    expect(install.slice(0, install.indexOf('deferUpdateInstallerLaunch'))).not.toContain('isQuitting = true');
  });

  it('does not let electron-updater take an unbridged quit-time elevation path', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const setup = source.slice(
      source.indexOf('function setupAutoUpdates()'),
      source.indexOf('function setUpdateSnapshot')
    );
    const install = source.slice(
      source.indexOf('async function installDownloadedUpdate'),
      source.indexOf('function recoverFromUpdateInstallerLaunchFailure')
    );

    expect(setup).toContain('autoUpdater.autoInstallOnAppQuit = false');
    expect(install).toContain('resolveDownloadedUpdateInstallerPath');
    expect(install).toContain('launchDownloadedUpdateInstaller({ installerPath, handoff })');
    expect(install).not.toContain('autoUpdater.quitAndInstall');
  });

  it('keeps the application alive throughout the installer handoff buffer', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const beforeQuit = source.slice(source.indexOf("app.on('before-quit'"));
    const cleanup = source.slice(
      source.indexOf('async function cleanupBeforeExit'),
      source.indexOf('const gotSingleInstanceLock')
    );

    expect(source).toContain('updateInstallerLaunchPending && !updateInstallerLaunchStarted');
    expect(beforeQuit.indexOf('isUpdateInstallerHandoffPending()')).toBeLessThan(
      beforeQuit.indexOf('updateInstallerBeforeQuitObserved = true')
    );
    expect(cleanup).toContain('if (isUpdateInstallerHandoffPending())');
    expect(cleanup).toContain("throw new Error('update installer launch pending')");
  });

  it('only blocks a follow-up quit when the failed installer attempt already reached before-quit', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const recovery = source.slice(
      source.indexOf('function recoverFromUpdateInstallFailure'),
      source.indexOf('async function prepareForUpdateInstall')
    );
    const beforeQuit = source.slice(source.indexOf("app.on('before-quit'"));

    expect(recovery).toContain('const beforeQuitWasObserved = updateInstallerBeforeQuitObserved');
    expect(beforeQuit).toContain('updateInstallerBeforeQuitObserved = true');
    expect(beforeQuit.indexOf('updateInstallerBeforeQuitObserved = true')).toBeLessThan(
      beforeQuit.indexOf('if (updateInstallerLaunchFailed)')
    );
  });

  it('makes normal application cleanup terminal before exiting', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const cleanup = source.slice(source.indexOf('async function cleanupBeforeExit'));

    expect(cleanup).toContain('lifecycle.suspendStarts()');
    expect(cleanup).toContain('await lifecycle.shutdown()');
    expect(cleanup.indexOf('await lifecycle.shutdown()')).toBeLessThan(cleanup.indexOf('app.exit(0)'));
  });

  it('restores runtime intent and schedules recovery when exit cleanup cannot restore the proxy', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const cleanup = source.slice(
      source.indexOf('async function cleanupBeforeExit'),
      source.indexOf('const gotSingleInstanceLock')
    );
    const recovery = cleanup.slice(cleanup.indexOf('catch (error)'));

    expect(cleanup).toContain('const shouldRestoreRuntimeIntent = runtimeIntent.capture() !== undefined');
    expect(recovery).toContain('lifecycle.resumeStarts()');
    expect(recovery).toContain('scheduleUpdateCheck(updatePeriodicIntervalMs)');
    expect(recovery).toContain('runtimeIntent.requestStart()');
    expect(recovery).toContain('startLifecycleWithSafeRetry(undefined, restoredIntentGeneration)');
    expect(recovery).toContain('appRuntimeCoordinator.scheduleRecovery(0)');
    expect(recovery.indexOf('lifecycle.resumeStarts()')).toBeLessThan(
      recovery.indexOf('appRuntimeCoordinator.scheduleRecovery(0)')
    );
    expect(recovery.indexOf('isQuitting = false')).toBeLessThan(
      recovery.indexOf('appRuntimeCoordinator.scheduleRecovery(0)')
    );
  });

  it('stops the fullscreen helper for an update and restarts it if installation is interrupted', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const prepare = source.slice(
      source.indexOf('async function prepareForUpdateInstall'),
      source.indexOf('function getUpdateInfoVersion')
    );
    const recovery = source.slice(
      source.indexOf('function recoverFromUpdateInstallFailure'),
      source.indexOf('async function prepareForUpdateInstall')
    );

    expect(prepare).toContain('stopPetFullscreenProbe({ restoreVisibility: false })');
    expect(recovery).toContain('restartPetFullscreenProbe()');
  });

  it('restarts fullscreen avoidance after an exit cleanup failure', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const cleanup = source.slice(
      source.indexOf('async function cleanupBeforeExit'),
      source.indexOf('const gotSingleInstanceLock')
    );
    const recovery = cleanup.slice(cleanup.indexOf('catch (error)'));

    expect(recovery).toContain('restartPetFullscreenProbe()');
    expect(recovery.indexOf('restartPetFullscreenProbe()')).toBeLessThan(recovery.indexOf('showMainWindow()'));
  });
});
