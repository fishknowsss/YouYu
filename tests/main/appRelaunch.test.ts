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
});
