import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  it('creates defaults with a stable generated secret', async () => {
    const store = await makeStore();
    const first = await store.read();
    const second = await store.read();

    expect(first.subscriptionUrl).toBe('');
    expect(first.settingsVersion).toBe(1);
    expect(first.controllerSecret).toHaveLength(32);
    expect(first.ruleProfile).toBe('subscription');
    expect(first.dnsEnhanced).toBe(false);
    expect(first.tunEnabled).toBe(true);
    expect(first.strictRouteEnabled).toBe(true);
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
        dnsEnhanced: true,
        snifferEnabled: true,
        tunEnabled: false,
        allowLan: false
      })
    );

    const store = new SettingsStore(dir);
    const migrated = await store.read();

    expect(migrated.tunEnabled).toBe(true);
    expect(migrated.strictRouteEnabled).toBe(true);
    expect(migrated.ruleProfile).toBe('subscription');
    expect(migrated.settingsVersion).toBe(1);
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
});
