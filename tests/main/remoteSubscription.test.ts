import { describe, expect, it, vi } from 'vitest';
import type { RemoteControlConfig } from '../../src/shared/ipc';
import type { ActiveRemoteConfigSnapshot } from '../../src/main/remoteConfig';
import { createRemoteSubscriptionCoordinator } from '../../src/main/remoteSubscription';

const identityAConfig: RemoteControlConfig = {
  version: 1,
  enabled: true,
  subscriptionUrl: 'https://identity-a.example/new',
  directRules: [],
  proxyRules: []
};
const snapshotA: ActiveRemoteConfigSnapshot = {
  binding: '["user-a","device-a"]',
  revision: JSON.stringify(identityAConfig),
  config: identityAConfig
};
const snapshotB: ActiveRemoteConfigSnapshot = {
  binding: '["user-b","device-b"]',
  revision: 'null'
};

describe('createRemoteSubscriptionCoordinator', () => {
  it('rejects a stale identity result queued after the new identity cleanup', async () => {
    const settings: { remoteSubscriptionUrl?: string } = {
      remoteSubscriptionUrl: 'https://identity-a.example/old'
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
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith('');
  });

  it('serializes an identity cleanup after an older valid write', async () => {
    const settings: { remoteSubscriptionUrl?: string } = {};
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
    const settings: { remoteSubscriptionUrl?: string } = {};
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
});
