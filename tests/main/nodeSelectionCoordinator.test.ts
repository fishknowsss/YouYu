import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createNodeHealthCoordinator } from '../../src/main/nodeHealthCoordinator';
import { NodeSelectionCoordinator } from '../../src/main/nodeSelectionCoordinator';

describe('NodeSelectionCoordinator', () => {
  it('does not let background health recovery replace an in-flight startup selection', async () => {
    const coordinator = new NodeSelectionCoordinator();
    let startupReady!: () => void;
    const startupStarted = new Promise<void>((resolve) => {
      startupReady = resolve;
    });
    let finishStartup!: () => void;
    const startupCanFinish = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const backgroundAction = vi.fn(async () => 'background-node');

    const startup = coordinator.replaceAutomatic(undefined, async (signal) => {
      startupReady();
      await startupCanFinish;
      signal.throwIfAborted();
      return 'startup-node';
    });
    await startupStarted;

    const background = coordinator.coalesceAutomatic(undefined, backgroundAction);
    await Promise.resolve();
    expect(backgroundAction).not.toHaveBeenCalled();

    finishStartup();
    await expect(startup).resolves.toBe('startup-node');
    await expect(background).resolves.toBe('startup-node');
    expect(backgroundAction).not.toHaveBeenCalled();
  });

  it('completes startup when the real health coordinator reaches recovery during automatic selection', async () => {
    const selection = new NodeSelectionCoordinator();
    let currentNode = '香港 temporary';
    let startupStarted!: () => void;
    const startupDidStart = new Promise<void>((resolve) => {
      startupStarted = resolve;
    });
    let finishStartup!: () => void;
    const startupCanFinish = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const startup = selection.coalesceAutomatic(undefined, async (signal) => {
      startupStarted();
      await startupCanFinish;
      signal.throwIfAborted();
      currentNode = '日本 selected';
      return currentNode;
    });
    await startupDidStart;

    let recoveryStarted!: () => void;
    const recoveryDidStart = new Promise<void>((resolve) => {
      recoveryStarted = resolve;
    });
    const competingRecovery = vi.fn(async () => 'background replacement');
    const onBackgroundError = vi.fn();
    const health = createNodeHealthCoordinator({
      totalAvailabilityCount: 1,
      initialDelayMs: 60_000,
      intervalMs: 300_000,
      retryDelayMs: 8_000,
      failureThreshold: 1,
      readContext: async () => ({ nodeName: currentNode, running: true, direct: false, revision: 'runtime-1' }),
      probeDelay: async () => undefined,
      recoverNode: async (_context, signal) => {
        recoveryStarted();
        return selection.coalesceAutomatic(signal, competingRecovery);
      },
      onBackgroundError
    });
    health.start();
    const backgroundCheck = health.checkNow();
    await recoveryDidStart;

    finishStartup();
    await expect(startup).resolves.toBe('日本 selected');
    await expect(backgroundCheck).resolves.toBeUndefined();
    expect(competingRecovery).not.toHaveBeenCalled();
    expect(onBackgroundError).not.toHaveBeenCalled();
    expect(health.inspect().health.nodeName).toBe('日本 selected');
    health.dispose();
  });

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

  it('lets a joining background caller stop waiting without aborting the shared startup selection', async () => {
    const coordinator = new NodeSelectionCoordinator();
    let finishStartup!: () => void;
    const startupCanFinish = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const startup = coordinator.replaceAutomatic(undefined, async () => {
      await startupCanFinish;
      return 'startup-node';
    });
    await Promise.resolve();

    const backgroundAbort = new AbortController();
    const backgroundAction = vi.fn(async () => 'background-node');
    const background = coordinator.coalesceAutomatic(backgroundAbort.signal, backgroundAction);
    backgroundAbort.abort(new Error('health monitor stopped'));

    await expect(background).rejects.toThrow('health monitor stopped');
    finishStartup();
    await expect(startup).resolves.toBe('startup-node');
    expect(backgroundAction).not.toHaveBeenCalled();
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

    expect(healthRecovery).toContain('nodeSelectionCoordinator.coalesceAutomatic');
    expect(healthRecovery).toContain('performPreferredAutoNode');
    const preferredSelection = source.slice(
      source.indexOf('function selectPreferredAutoNode'),
      source.indexOf('async function performPreferredAutoNode')
    );
    expect(preferredSelection).toContain('nodeSelectionCoordinator.coalesceAutomatic');
    const startupSelection = await readFile('src/main/proxyStart.ts', 'utf8');
    const startFlow = startupSelection.slice(
      startupSelection.indexOf('export async function runProxyStartSequence'),
      startupSelection.indexOf('export function schedulePreferredAutoNodeRefinement')
    );
    expect(startFlow).toContain('schedulePreferredAutoNodeRefinement');
    expect(startFlow).not.toContain('await deps.selectPreferredAutoNode');
    expect(startupSelection).toContain('继续使用当前节点');
    expect(manualSelection.indexOf('nodeHealthCoordinator.invalidate()')).toBeLessThan(
      manualSelection.indexOf('nodeSelectionCoordinator.runUserAction')
    );
    expect(strategySelection).toContain('nodeSelectionCoordinator.runUserAction');
  });

  it('uses a longer health probe, three failures, and same-region cooldown before switching', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    expect(source).toContain('const nodeHealthProbeTimeoutMs = 4000');
    expect(source).toContain('const nodeHealthRetryDelayMs = 15000');
    expect(source).toContain('const nodeHealthFailureThreshold = 3');
    expect(source).toContain('createNodeSwitchCooldown');

    const healthProbe = source.slice(source.indexOf('async probeDelay'), source.indexOf('async recoverNode'));
    expect(healthProbe).toContain('timeoutMs: nodeHealthProbeTimeoutMs');

    const healthRecovery = source.slice(source.indexOf('async recoverNode'), source.indexOf('onTransientFailure'));
    expect(healthRecovery).toContain('allowAvoidFallback: false');
    expect(healthRecovery).toContain('avoidNodes');
    expect(healthRecovery).toContain('nodeSwitchCooldown.remember');
    expect(source).toContain('onRecoverySkipped');
  });
});
