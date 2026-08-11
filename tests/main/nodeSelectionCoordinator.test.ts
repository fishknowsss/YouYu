import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { NodeSelectionCoordinator } from '../../src/main/nodeSelectionCoordinator';

describe('NodeSelectionCoordinator', () => {
  it('waits for an aborted automatic rollback before applying a newer user choice', async () => {
    const coordinator = new NodeSelectionCoordinator();
    const events: string[] = [];
    let releaseRollback!: () => void;
    const rollbackReleased = new Promise<void>((resolve) => {
      releaseRollback = resolve;
    });
    let automaticStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      automaticStarted = resolve;
    });

    const automatic = coordinator.replaceAutomatic(undefined, async (signal) => {
      events.push('automatic-write');
      automaticStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }).catch(async () => {
        await rollbackReleased;
        events.push('automatic-rollback');
        throw new Error('automatic selection cancelled');
      });
    });
    await started;

    const user = coordinator.runUserAction(async () => {
      events.push('user-write');
      return 'manual-new';
    });
    await Promise.resolve();
    expect(events).toEqual(['automatic-write']);

    releaseRollback();
    await expect(automatic).rejects.toThrow('automatic selection cancelled');
    await expect(user).resolves.toBe('manual-new');
    expect(events).toEqual(['automatic-write', 'automatic-rollback', 'user-write']);
  });

  it('propagates external cancellation into an automatic selection', async () => {
    const coordinator = new NodeSelectionCoordinator();
    const external = new AbortController();
    const automatic = coordinator.replaceAutomatic(external.signal, async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    external.abort(new Error('subscription refresh cancelled'));
    await expect(automatic).rejects.toThrow('subscription refresh cancelled');
  });

  it('routes background recovery and explicit selector writes through the same ownership boundary', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const healthRecovery = source.slice(source.indexOf('async recoverNode'), source.indexOf('onTransientFailure'));
    const manualSelection = source.slice(
      source.indexOf('ipcMain.handle(ipcChannels.selectNode'),
      source.indexOf('ipcMain.handle(ipcChannels.selectBestAutoNode')
    );
    const strategySelection = source.slice(
      source.indexOf('ipcMain.handle(ipcChannels.selectStrategy'),
      source.indexOf('ipcMain.handle(ipcChannels.setMode')
    );

    expect(healthRecovery).toContain('nodeSelectionCoordinator.replaceAutomatic');
    expect(healthRecovery).toContain('performPreferredAutoNode');
    expect(manualSelection.indexOf('nodeHealthCoordinator.invalidate()')).toBeLessThan(
      manualSelection.indexOf('nodeSelectionCoordinator.runUserAction')
    );
    expect(strategySelection).toContain('nodeSelectionCoordinator.runUserAction');
  });
});
