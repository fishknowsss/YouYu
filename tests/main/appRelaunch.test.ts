import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildProxyRelaunchArguments, resumeProxyAfterRelaunchArgument } from '../../src/main/appRelaunch';

describe('application relaunch safety', () => {
  it('preserves normal arguments and emits one proxy-resume argument', () => {
    expect(
      buildProxyRelaunchArguments([
        'out/main/index.js',
        '--hidden',
        resumeProxyAfterRelaunchArgument,
        '--shutdown-for-install'
      ])
    ).toEqual(['out/main/index.js', '--hidden', resumeProxyAfterRelaunchArgument]);
  });

  it('stops the old runtime before scheduling relaunch and exits only afterward', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const cleanup = source.slice(
      source.indexOf('async function cleanupBeforeExit'),
      source.indexOf('const gotSingleInstanceLock')
    );

    expect(cleanup.indexOf('lifecycle.suspendStarts()')).toBeLessThan(cleanup.indexOf('await lifecycle.stop()'));
    expect(cleanup.indexOf('await lifecycle.stop()')).toBeLessThan(cleanup.indexOf('app.relaunch'));
    expect(cleanup.indexOf('app.relaunch')).toBeLessThan(cleanup.indexOf('app.exit(0)'));
  });

  it('requires an identity before cleanup and resumes through the guarded start path', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const restart = source.slice(
      source.indexOf('async function restartKernelAndApp'),
      source.indexOf('function registerIpc')
    );
    const initialization = source.slice(source.indexOf('.whenReady()'));

    expect(restart.indexOf('await requireTrafficIdentity()')).toBeLessThan(restart.indexOf('await cleanupBeforeExit'));
    expect(initialization).toContain('if (resumeProxyAfterRelaunch)');
    expect(initialization).toContain('void startProxy()');
  });

  it('runs one complete tray repair before relaunching without an intermediate core restart', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const combinedRepair = source.slice(
      source.indexOf('async function repairNetworkAndRestartApp'),
      source.indexOf('function registerIpc')
    );
    const trayMenu = source.slice(
      source.indexOf('function refreshTrayMenu'),
      source.indexOf('async function runTrayAction')
    );

    expect(combinedRepair.indexOf('await repairProxy(undefined, { resumeRuntime: false })')).toBeLessThan(
      combinedRepair.indexOf('return restartKernelAndApp(snapshot)')
    );
    expect(trayMenu).toContain("label: '网络修复'");
    expect(trayMenu).not.toContain("label: '重启内核并重启软件'");
    expect(trayMenu).not.toContain("label: '重型网络修复'");
  });

  it('blocks competing core starts while repair owns the lifecycle queue', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const guardedStart = source.slice(
      source.indexOf('async function startLifecycleWithSafeRetry'),
      source.indexOf('async function startLifecycleForUser')
    );
    const guardedRestart = source.slice(
      source.indexOf('async function restartLifecycleForIntent'),
      source.indexOf('function runtimeActionsForIntent')
    );
    const repair = source.slice(
      source.indexOf('async function repairProxy'),
      source.indexOf('async function registerTrafficIdentity')
    );

    expect(guardedStart.match(/throwIfNetworkRepairInProgress/g)).toHaveLength(3);
    expect(guardedRestart.match(/throwIfNetworkRepairInProgress/g)).toHaveLength(3);
    expect(repair).toContain('allowDuringNetworkRepair: true');
    expect(repair).toContain('if (handingOffToRelaunch) lifecycle.suspendStarts()');
    expect(repair).toContain('scheduleSubscriptionRefresh()');
  });

  it('keeps automatic runtime recovery on the safe retry policy and reserves full repair for explicit repair', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const unexpectedExitRecovery = source.slice(
      source.indexOf('async function performRuntimeRecovery'),
      source.indexOf('function isExpectedAppRuntimeCancellation')
    );
    const guardedStart = source.slice(
      source.indexOf('async function startLifecycleWithSafeRetry'),
      source.indexOf('async function startLifecycleForUser')
    );
    const guardedRestart = source.slice(
      source.indexOf('async function restartLifecycleForIntent'),
      source.indexOf('function runtimeActionsForIntent')
    );
    const explicitRepair = source.slice(
      source.indexOf('async function repairProxy'),
      source.indexOf('async function registerTrafficIdentity')
    );

    expect(guardedStart).toContain('runRuntimeOperationWithSafeRetry');
    expect(guardedRestart).toContain('runRuntimeOperationWithSafeRetry');
    expect(unexpectedExitRecovery).not.toContain('lifecycle.repair');
    expect(guardedStart).not.toContain('lifecycle.repair');
    expect(guardedRestart).not.toContain('lifecycle.repair');
    expect(explicitRepair).toContain('repairLifecycle: (repairSignal) => lifecycle.repair(repairSignal)');
  });

  it('selects a low-risk diagnostic repair before the complete repair chain', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const targetedRepair = source.slice(
      source.indexOf('async function runIssueTargetedRepair'),
      source.indexOf('async function repairProxy')
    );
    const repair = source.slice(
      source.indexOf('async function repairProxy'),
      source.indexOf('async function registerTrafficIdentity')
    );

    expect(targetedRepair).toContain('runTargetedNetworkRepair');
    expect(targetedRepair).toContain('disableSystemProxy');
    expect(targetedRepair).toContain('flushDns');
    expect(targetedRepair).toContain('stopKernel');
    expect(targetedRepair).toContain('refreshSubscription');
    expect(repair).toContain('issueKind: options.issueKind ?? classifyDiagnosticIssue(lastError)');
    expect(repair.indexOf('runTargetedRepair: runIssueTargetedRepair')).toBeLessThan(
      repair.indexOf('repairLifecycle:')
    );
  });
});
