import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/main/storage/settings';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
  tempDirs.push(dir);
  return new SettingsStore(dir);
}

describe('SettingsStore', () => {
  const bundledSubscriptionUrl = 'https://default.example.com/sub';

  it('creates defaults with a stable generated secret', async () => {
    const store = await makeStore();
    const first = await store.read();
    const second = await store.read();

    expect(first.subscriptionUrl).toBe('');
    expect(first.settingsVersion).toBe(3);
    expect(first.controllerSecret).toHaveLength(32);
    expect(first.ruleProfile).toBe('subscription');
    expect(first.dnsEnhanced).toBe(true);
    expect(first.tunEnabled).toBe(false);
    expect(first.strictRouteEnabled).toBe(true);
    expect(first.subscriptionRefreshIntervalHours).toBe(12);
    expect(second.controllerSecret).toBe(first.controllerSecret);
  });

  it('persists subscription url without replacing the secret', async () => {
    const store = await makeStore();
    const before = await store.read();

    await store.update({ subscriptionUrl: 'https://example.com/sub' });
    const after = await store.read();

    expect(after.subscriptionUrl).toBe('https://example.com/sub');
    expect(after.controllerSecret).toBe(before.controllerSecret);
  });

  it('applies a remote subscription without replacing the local subscription', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);
    const store = new SettingsStore(dir);

    await store.update({ subscriptionUrl: 'https://local.example.com/sub' });
    const remote = await store.update({ remoteSubscriptionUrl: ' https://remote.example.com/sub ' });

    expect(remote.subscriptionUrl).toBe('https://remote.example.com/sub');
    expect(remote.localSubscriptionUrl).toBe('https://local.example.com/sub');
    expect(remote.remoteSubscriptionUrl).toBe('https://remote.example.com/sub');

    const persisted = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
      subscriptionUrl?: string;
      remoteSubscriptionUrl?: string;
    };
    expect(persisted.subscriptionUrl).toBe('https://local.example.com/sub');
    expect(persisted.remoteSubscriptionUrl).toBe('https://remote.example.com/sub');

    const cleared = await store.update({ remoteSubscriptionUrl: null });
    expect(cleared.subscriptionUrl).toBe('https://local.example.com/sub');
    expect(cleared.remoteSubscriptionUrl).toBeUndefined();
  });

  it('persists the desktop pet window position', async () => {
    const store = await makeStore();

    await store.update({ petWindow: { x: 128.6, y: 420.2 } });
    const after = await store.read();

    expect(after.petWindow).toEqual({ x: 129, y: 420 });
  });

  it('migrates older settings to the current defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        subscriptionUrl: 'https://example.com/sub',
        controllerSecret: '1234567890abcdef1234567890abcdef',
        mode: 'rule',
        strategy: 'auto',
        ruleProfile: 'smart',
        selectedNode: '',
        systemProxyEnabled: true,
        dnsEnhanced: false,
        snifferEnabled: true,
        tunEnabled: false,
        allowLan: false,
        subscriptionRefreshIntervalHours: 99
      })
    );

    const store = new SettingsStore(dir);
    const migrated = await store.read();

    expect(migrated.dnsEnhanced).toBe(true);
    expect(migrated.tunEnabled).toBe(false);
    expect(migrated.strictRouteEnabled).toBe(true);
    expect(migrated.ruleProfile).toBe('subscription');
    expect(migrated.subscriptionRefreshIntervalHours).toBe(12);
    expect(migrated.settingsVersion).toBe(3);
  });

  it('persists allowed subscription refresh intervals', async () => {
    const store = await makeStore();

    await store.update({ subscriptionRefreshIntervalHours: 6 });
    const after = await store.read();

    expect(after.subscriptionRefreshIntervalHours).toBe(6);
  });

  it('migrates missing rule profile to the airport config default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        subscriptionUrl: 'https://example.com/sub',
        controllerSecret: '1234567890abcdef1234567890abcdef',
        mode: 'rule',
        strategy: 'auto',
        selectedNode: '',
        systemProxyEnabled: true,
        dnsEnhanced: true,
        snifferEnabled: true,
        tunEnabled: true,
        strictRouteEnabled: true,
        allowLan: false
      })
    );

    const store = new SettingsStore(dir);
    const migrated = await store.read();

    expect(migrated.ruleProfile).toBe('subscription');
  });

  it('preserves smart routing after settings have been versioned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        settingsVersion: 1,
        subscriptionUrl: 'https://example.com/sub',
        controllerSecret: '1234567890abcdef1234567890abcdef',
        mode: 'rule',
        strategy: 'auto',
        ruleProfile: 'smart',
        selectedNode: '',
        systemProxyEnabled: true,
        dnsEnhanced: true,
        snifferEnabled: true,
        tunEnabled: true,
        strictRouteEnabled: true,
        allowLan: false
      })
    );

    const store = new SettingsStore(dir);
    const current = await store.read();

    expect(current.ruleProfile).toBe('smart');
  });

  it('disables LAN access from older settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        settingsVersion: 1,
        subscriptionUrl: 'https://example.com/sub',
        controllerSecret: '1234567890abcdef1234567890abcdef',
        mode: 'rule',
        strategy: 'auto',
        ruleProfile: 'subscription',
        selectedNode: '',
        systemProxyEnabled: true,
        dnsEnhanced: true,
        snifferEnabled: true,
        tunEnabled: true,
        strictRouteEnabled: true,
        allowLan: true
      })
    );

    const store = new SettingsStore(dir);
    const current = await store.read();

    expect(current.allowLan).toBe(false);
  });

  it('forces a bundled subscription when one is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);

    const store = new SettingsStore(dir, {
      defaultSubscriptionUrl: ' https://default.example.com/sub '
    });
    const first = await store.read();

    expect(first.subscriptionUrl).toBe('https://default.example.com/sub');

    await store.update({ subscriptionUrl: ' https://user.example.com/sub ' });
    const after = await store.read();

    expect(after.subscriptionUrl).toBe('https://default.example.com/sub');
  });

  it('overwrites an existing user subscription when a bundled subscription is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        settingsVersion: 1,
        subscriptionUrl: 'https://user.example.com/sub',
        controllerSecret: '1234567890abcdef1234567890abcdef',
        mode: 'rule',
        strategy: 'manual',
        ruleProfile: 'subscription',
        selectedNode: 'old-node',
        systemProxyEnabled: true,
        dnsEnhanced: false,
        snifferEnabled: true,
        tunEnabled: true,
        strictRouteEnabled: true,
        allowLan: false
      })
    );

    const store = new SettingsStore(dir, {
      defaultSubscriptionUrl: 'https://default.example.com/sub'
    });
    const current = await store.read();

    expect(current.subscriptionUrl).toBe('https://default.example.com/sub');
    expect(current.strategy).toBe('auto');
    expect(current.selectedNode).toBe('');

    const persisted = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
      subscriptionUrl?: string;
      strategy?: string;
      selectedNode?: string;
    };
    expect(persisted.subscriptionUrl).toBe('https://default.example.com/sub');
    expect(persisted.strategy).toBe('auto');
    expect(persisted.selectedNode).toBe('');
  });

  it('overwrites an older bundled subscription and clears stale manual node selection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        settingsVersion: 2,
        subscriptionUrl: 'https://override3357.cnqq.de/q/934d89f91a0c21879f743d5fd7f4faa2',
        controllerSecret: '1234567890abcdef1234567890abcdef',
        mode: 'rule',
        strategy: 'manual',
        ruleProfile: 'subscription',
        selectedNode: 'old-node',
        systemProxyEnabled: true,
        dnsEnhanced: true,
        snifferEnabled: true,
        tunEnabled: false,
        strictRouteEnabled: true,
        allowLan: false
      })
    );

    const store = new SettingsStore(dir, {
      defaultSubscriptionUrl: bundledSubscriptionUrl
    });
    const current = await store.read();

    expect(current.subscriptionUrl).toBe(bundledSubscriptionUrl);
    expect(current.strategy).toBe('auto');
    expect(current.selectedNode).toBe('');

    const persisted = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
      subscriptionUrl?: string;
      strategy?: string;
      selectedNode?: string;
    };
    expect(persisted.subscriptionUrl).toBe(bundledSubscriptionUrl);
    expect(persisted.strategy).toBe('auto');
    expect(persisted.selectedNode).toBe('');
  });

  it('overwrites a stale subscription even after the settings version is current', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        settingsVersion: 3,
        subscriptionUrl: 'https://override3357.cnqq.de/q/934d89f91a0c21879f743d5fd7f4faa2',
        controllerSecret: '1234567890abcdef1234567890abcdef',
        mode: 'rule',
        strategy: 'manual',
        ruleProfile: 'subscription',
        selectedNode: 'old-node',
        systemProxyEnabled: true,
        dnsEnhanced: true,
        snifferEnabled: true,
        tunEnabled: false,
        strictRouteEnabled: true,
        allowLan: false
      })
    );

    const store = new SettingsStore(dir, {
      defaultSubscriptionUrl: bundledSubscriptionUrl
    });
    const current = await store.read();

    expect(current.subscriptionUrl).toBe(bundledSubscriptionUrl);
    expect(current.strategy).toBe('auto');
    expect(current.selectedNode).toBe('');
  });

  it('keeps a current manual selection after the bundled subscription migration has run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'youyu-settings-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        settingsVersion: 3,
        subscriptionUrl: bundledSubscriptionUrl,
        controllerSecret: '1234567890abcdef1234567890abcdef',
        mode: 'rule',
        strategy: 'manual',
        ruleProfile: 'subscription',
        selectedNode: 'current-node',
        systemProxyEnabled: true,
        dnsEnhanced: true,
        snifferEnabled: true,
        tunEnabled: false,
        strictRouteEnabled: true,
        allowLan: false
      })
    );

    const store = new SettingsStore(dir, {
      defaultSubscriptionUrl: bundledSubscriptionUrl
    });
    const current = await store.read();

    expect(current.subscriptionUrl).toBe(bundledSubscriptionUrl);
    expect(current.strategy).toBe('manual');
    expect(current.selectedNode).toBe('current-node');
  });
});
