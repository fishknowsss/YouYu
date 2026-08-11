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
    const source = await readFile('src/main/index.ts', 'utf8');
    const startFlow = source.slice(
      source.indexOf('async function performStartProxy'),
      source.indexOf('function startProxy')
    );

    expect(startFlow.match(/syncRequiredRemoteConfig\(/g)).toHaveLength(2);
    expect(startFlow.indexOf('syncRequiredRemoteConfig({ signal })')).toBeLessThan(
      startFlow.indexOf('startLifecycleWithSafeRetry')
    );
    expect(startFlow.indexOf('trafficRegistration.activatePending()')).toBeLessThan(
      startFlow.lastIndexOf('syncRequiredRemoteConfig(')
    );
    expect(startFlow).toContain('runtimeIntent.cancel();');
    expect(startFlow).toContain('await lifecycle');
  });
});
