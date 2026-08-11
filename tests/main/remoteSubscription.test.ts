import { describe, expect, it, vi } from 'vitest';
import type { RemoteControlConfig } from '../../src/shared/ipc';
import type { ActiveRemoteConfigSnapshot } from '../../src/main/remoteConfig';
import { createRemoteSubscriptionCoordinator } from '../../src/main/remoteSubscription';

const identityAConfig: RemoteControlConfig = {
  version: 1,
  enabled: true,
  subscriptionUrl: 'https://identity-a.example/new',
  ruleProfile: 'subscription',
  directRules: [],
  proxyRules: []
};
const snapshotA: ActiveRemoteConfigSnapshot = {
  binding: '["user-a","device-a"]',
  revision: JSON.stringify(identityAConfig),
  ready: true,
  canEditManagedConfig: false,
  config: identityAConfig
};
const snapshotB: ActiveRemoteConfigSnapshot = {
  binding: '["user-b","device-b"]',
  revision: 'null',
  ready: false,
  canEditManagedConfig: false
};

describe('createRemoteSubscriptionCoordinator', () => {
  it('rejects a stale identity result queued after the new identity cleanup', async () => {
    const settings: { remoteSubscriptionUrl?: string; ruleProfile?: 'ruleset' | 'subscription' } = {
      remoteSubscriptionUrl: 'https://identity-a.example/old',
      ruleProfile: 'ruleset'
    };
    const onChanged = vi.fn();
    const coordinator = createRemoteSubscriptionCoordinator({
      readSettings: async () => ({ ...settings }),
      updateRemoteSubscription: async (value) => {
        settings.remoteSubscriptionUrl = value ?? undefined;
      },
      isSnapshotCurrent: async (snapshot) => snapshot.binding === snapshotB.binding,
      getActiveSnapshot: async () => snapshotB,
      onChanged
    });

    await Promise.all([coordinator.apply(undefined), coordinator.apply(identityAConfig, snapshotA)]);

    expect(settings.remoteSubscriptionUrl).toBeUndefined();
    expect(settings.ruleProfile).toBe('ruleset');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith('');
  });

  it('serializes an identity cleanup after an older valid write', async () => {
    const settings: { remoteSubscriptionUrl?: string; ruleProfile?: 'ruleset' | 'subscription' } = {};
    const coordinator = createRemoteSubscriptionCoordinator({
      readSettings: async () => ({ ...settings }),
      updateRemoteSubscription: async (value) => {
        settings.remoteSubscriptionUrl = value ?? undefined;
      },
      isSnapshotCurrent: async () => true,
      getActiveSnapshot: async () => snapshotA
    });

    await Promise.all([coordinator.apply(identityAConfig, snapshotA), coordinator.apply(undefined)]);

    expect(settings.remoteSubscriptionUrl).toBeUndefined();
  });

  it('repairs the setting when identity changes during the persisted write', async () => {
    const settings: { remoteSubscriptionUrl?: string; ruleProfile?: 'ruleset' | 'subscription' } = {};
    let current = snapshotA;
    const writes: Array<string | null> = [];
    const coordinator = createRemoteSubscriptionCoordinator({
      readSettings: async () => ({ ...settings }),
      updateRemoteSubscription: async (value) => {
        writes.push(value);
        settings.remoteSubscriptionUrl = value ?? undefined;
        if (writes.length === 1) current = snapshotB;
      },
      isSnapshotCurrent: async (snapshot) => snapshot.binding === current.binding,
      getActiveSnapshot: async () => current
    });

    await expect(coordinator.apply(identityAConfig, snapshotA)).resolves.toBe(true);

    expect(writes).toEqual(['https://identity-a.example/new', null]);
    expect(settings.remoteSubscriptionUrl).toBeUndefined();
  });

  it('keeps the local rule profile isolated when the cloud rule differs', async () => {
    const settings: { remoteSubscriptionUrl?: string; ruleProfile?: 'ruleset' | 'subscription' } = {
      remoteSubscriptionUrl: identityAConfig.subscriptionUrl,
      ruleProfile: 'ruleset'
    };
    const coordinator = createRemoteSubscriptionCoordinator({
      readSettings: async () => ({ ...settings }),
      updateRemoteSubscription: async (value) => {
        settings.remoteSubscriptionUrl = value ?? undefined;
      },
      isSnapshotCurrent: async () => true,
      getActiveSnapshot: async () => snapshotA
    });

    await expect(coordinator.apply(identityAConfig, snapshotA)).resolves.toBe(false);

    expect(settings.ruleProfile).toBe('ruleset');
  });

  it('switches A to B with one persisted URL write per identity and never copies either cloud rule locally', async () => {
    const identityBConfig: RemoteControlConfig = {
      version: 2,
      enabled: true,
      subscriptionUrl: 'https://identity-b.example/sub',
      ruleProfile: 'ruleset',
      directRules: [],
      proxyRules: []
    };
    const settings: { remoteSubscriptionUrl?: string; ruleProfile?: 'ruleset' | 'subscription' } = {
      ruleProfile: 'subscription'
    };
    const writes: Array<string | null> = [];
    const coordinator = createRemoteSubscriptionCoordinator({
      readSettings: async () => ({ ...settings }),
      updateRemoteSubscription: async (value) => {
        writes.push(value);
        settings.remoteSubscriptionUrl = value ?? undefined;
      },
      isSnapshotCurrent: async () => true,
      getActiveSnapshot: async () => snapshotB
    });

    await coordinator.apply(identityAConfig);
    await coordinator.apply(identityBConfig);

    expect(writes).toEqual(['https://identity-a.example/new', 'https://identity-b.example/sub']);
    expect(settings.remoteSubscriptionUrl).toBe('https://identity-b.example/sub');
    expect(settings.ruleProfile).toBe('subscription');
  });

  it('clears a disabled cloud subscription without copying its rule into local settings', async () => {
    const disabledConfig: RemoteControlConfig = {
      ...identityAConfig,
      version: 2,
      enabled: false,
      ruleProfile: 'subscription'
    };
    const settings: { remoteSubscriptionUrl?: string; ruleProfile?: 'ruleset' | 'subscription' } = {
      remoteSubscriptionUrl: identityAConfig.subscriptionUrl,
      ruleProfile: 'ruleset'
    };
    const writes: Array<string | null> = [];
    const coordinator = createRemoteSubscriptionCoordinator({
      readSettings: async () => ({ ...settings }),
      updateRemoteSubscription: async (value) => {
        writes.push(value);
        settings.remoteSubscriptionUrl = value ?? undefined;
      },
      isSnapshotCurrent: async () => true,
      getActiveSnapshot: async () => snapshotB
    });

    await coordinator.apply(disabledConfig);

    expect(writes).toEqual([null]);
    expect(settings.remoteSubscriptionUrl).toBeUndefined();
    expect(settings.ruleProfile).toBe('ruleset');
  });
});
