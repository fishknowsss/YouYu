import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { syncRequiredBoundRemoteConfig } from '../../src/main/remoteConfigAuthority';

describe('bound remote config authority', () => {
  it('fails closed when a verified identity still has no current cache after sync', async () => {
    const startRuntime = vi.fn();

    await expect(
      syncRequiredBoundRemoteConfig({
        sync: async () => false,
        readSnapshot: async () => ({
          binding: '["user-1","device-1"]',
          revision: 'null',
          ready: false,
          canEditManagedConfig: false
        })
      }).then(startRuntime)
    ).rejects.toThrow('云端配置尚未同步');
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('allows an identity-bound cache to keep working when the network sync made no change', async () => {
    await expect(
      syncRequiredBoundRemoteConfig({
        sync: async () => false,
        readSnapshot: async () => ({
          binding: '["user-1","device-1"]',
          revision: '{"version":3}',
          ready: true,
          canEditManagedConfig: false,
          config: {
            version: 3,
            enabled: true,
            configSource: 'global',
            directRules: [],
            proxyRules: []
          }
        })
      })
    ).resolves.toBe(false);
  });

  it('does not impose cloud readiness when no verified identity is bound', async () => {
    await expect(
      syncRequiredBoundRemoteConfig({
        sync: async () => 'local',
        readSnapshot: async () => ({
          revision: 'null',
          ready: false,
          canEditManagedConfig: false
        })
      })
    ).resolves.toBe('local');
  });

  it('checks the required cloud binding both before startup and after pending activation', async () => {
    const source = await readFile('src/main/proxyStart.ts', 'utf8');
    const startFlow = source.slice(
      source.indexOf('export async function runProxyStartSequence'),
      source.indexOf('export function schedulePreferredAutoNodeRefinement')
    );

    expect(startFlow).toContain('deps.syncRequiredRemoteConfig({ signal })');
    expect(startFlow.indexOf('deps.syncRequiredRemoteConfig({ signal })')).toBeLessThan(
      startFlow.indexOf('deps.startLifecycle(signal, intentGeneration)')
    );
    expect(startFlow.indexOf('deps.activatePending()')).toBeLessThan(
      startFlow.indexOf('schedulePostStartRemoteConfigSync')
    );
    expect(startFlow).toContain('schedulePostStartRemoteConfigSync');
    expect(startFlow).toContain('restartIfRunning: true');
    expect(startFlow).not.toContain('deps.cancelIntent()');
    expect(startFlow).not.toContain('.stopLifecycle()');
  });

  it('treats sanitized remote transport failures as recoverable quiet-sync errors', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const recoverable = source.slice(
      source.indexOf('function isRecoverableSyncError'),
      source.indexOf('function clearLastError')
    );

    expect(recoverable).toContain("'REQUEST_FAILED'");
    expect(recoverable).toContain("'FETCH_FAILED'");
    expect(recoverable).toContain("'TIMEOUT'");
  });
});
