import type { AppSettingsInput, AppSnapshot, MihomoMode, StrategyKey } from '../shared/ipc';
import type { LifecycleController } from './lifecycle';
import type { MihomoApiClient } from './mihomo/api';
import type { AppSettings } from './storage/settings';

type SettingsAccess = {
  read: () => Promise<AppSettings>;
  update: (next: AppSettingsInput) => Promise<AppSettings>;
};

type CreateMihomoApi = (options: { secret: string }) => Pick<
  MihomoApiClient,
  'updateProvider' | 'setMode' | 'selectStrategy' | 'testNodeDelay' | 'testAllNodes' | 'closeConnections'
>;

type AppActionDeps = {
  settingsStore: SettingsAccess;
  lifecycle: LifecycleController;
  createMihomoApi: CreateMihomoApi;
  createSnapshot: () => Promise<AppSnapshot>;
};

export async function saveSubscriptionSettings(
  deps: Pick<AppActionDeps, 'settingsStore' | 'lifecycle' | 'createSnapshot'>,
  settings: AppSettingsInput | string,
): Promise<AppSnapshot> {
  const input = typeof settings === 'string' ? { subscriptionUrl: settings } : settings;
  const next = {
    ...input,
    subscriptionUrl:
      typeof input.subscriptionUrl === 'string' ? input.subscriptionUrl.trim() : undefined
  };

  await deps.settingsStore.update(next);
  if (deps.lifecycle.getStatus() === 'running') {
    await deps.lifecycle.stop();
    await deps.lifecycle.start();
  }
  return deps.createSnapshot();
}

export async function updateSubscriptionNodes(deps: AppActionDeps): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.read();
  if (!settings.subscriptionUrl.trim()) {
    throw new Error('missing subscription url');
  }

  const wasStopped = deps.lifecycle.getStatus() !== 'running';
  if (wasStopped) {
    await deps.lifecycle.start();
  }

  if (!wasStopped) {
    await deps.lifecycle.stop();
    await deps.lifecycle.start();
  }
  return deps.createSnapshot();
}

export async function setMihomoMode(deps: AppActionDeps, mode: MihomoMode): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.update({ mode });
  if (deps.lifecycle.getStatus() === 'running') {
    await deps.createMihomoApi({ secret: settings.controllerSecret }).setMode(mode);
  }
  return deps.createSnapshot();
}

export async function selectMihomoStrategy(
  deps: AppActionDeps,
  strategy: StrategyKey,
): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.update({ strategy, selectedNode: null });
  if (deps.lifecycle.getStatus() === 'running') {
    await deps.createMihomoApi({ secret: settings.controllerSecret }).selectStrategy(strategy);
  }
  return deps.createSnapshot();
}

export async function testMihomoNode(
  deps: Omit<AppActionDeps, 'createMihomoApi'> & {
    createMihomoApi: (options: { secret: string }) => Pick<MihomoApiClient, 'testNodeDelay'>;
  },
  name: string,
): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.read();
  if (deps.lifecycle.getStatus() !== 'running') {
    await deps.lifecycle.start();
  }
  await deps.createMihomoApi({ secret: settings.controllerSecret }).testNodeDelay(name);
  return deps.createSnapshot();
}

export async function testAllMihomoNodes(deps: AppActionDeps): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.read();
  if (deps.lifecycle.getStatus() !== 'running') {
    await deps.lifecycle.start();
  }
  await deps.createMihomoApi({ secret: settings.controllerSecret }).testAllNodes();
  return deps.createSnapshot();
}

export async function closeMihomoConnections(deps: AppActionDeps): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.read();
  if (deps.lifecycle.getStatus() === 'running') {
    await deps.createMihomoApi({ secret: settings.controllerSecret }).closeConnections();
  }
  return deps.createSnapshot();
}
