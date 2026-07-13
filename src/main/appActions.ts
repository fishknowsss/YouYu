import type { AppSettingsInput, AppSnapshot, MihomoMode, ProxyNode, StrategyKey } from '../shared/ipc';
import type { LifecycleController } from './lifecycle';
import type { MihomoApiClient } from './mihomo/api';
import type { AppSettings } from './storage/settings';

type SettingsAccess = {
  read: () => Promise<AppSettings>;
  update: (next: AppSettingsInput) => Promise<AppSettings>;
};

type CreateMihomoApi = (options: {
  secret: string;
}) => Pick<
  MihomoApiClient,
  'updateProvider' | 'setMode' | 'selectStrategy' | 'testNodeDelay' | 'testAllNodes' | 'closeConnections'
>;

type TestAllNodesOptions = {
  signal?: AbortSignal;
  onProgress?: () => void | Promise<void>;
  onNodeTested?: (node: ProxyNode) => void | Promise<void>;
};

type TestNodeOptions = {
  onDelayTested?: (name: string, delay: number | undefined) => void | Promise<void>;
};

type AppActionDeps = {
  settingsStore: SettingsAccess;
  lifecycle: LifecycleController;
  runtime?: {
    start: (signal?: AbortSignal) => Promise<void>;
    restart: (signal?: AbortSignal) => Promise<void>;
  };
  createMihomoApi: CreateMihomoApi;
  createSnapshot: () => Promise<AppSnapshot>;
};

export async function saveSubscriptionSettings(
  deps: Pick<AppActionDeps, 'settingsStore' | 'lifecycle' | 'runtime' | 'createSnapshot'>,
  settings: AppSettingsInput | string,
  options: { signal?: AbortSignal } = {}
): Promise<AppSnapshot> {
  options.signal?.throwIfAborted();
  const input = typeof settings === 'string' ? { subscriptionUrl: settings } : settings;
  const next = {
    ...input,
    subscriptionUrl: typeof input.subscriptionUrl === 'string' ? input.subscriptionUrl.trim() : undefined
  };

  await deps.settingsStore.update(next);
  options.signal?.throwIfAborted();
  if (deps.lifecycle.getStatus() === 'running') {
    await restartWithRepairRetry(deps, options.signal);
  }
  return deps.createSnapshot();
}

export async function updateSubscriptionNodes(
  deps: AppActionDeps,
  options: { signal?: AbortSignal } = {}
): Promise<AppSnapshot> {
  options.signal?.throwIfAborted();
  const settings = await deps.settingsStore.read();
  if (!settings.subscriptionUrl.trim()) {
    throw new Error('missing subscription url');
  }

  const wasStopped = deps.lifecycle.getStatus() !== 'running';
  if (wasStopped) {
    await startWithRepairRetry(deps, options.signal);
    return deps.createSnapshot();
  }

  try {
    await deps.createMihomoApi({ secret: settings.controllerSecret }).updateProvider({ signal: options.signal });
  } catch (_error) {
    options.signal?.throwIfAborted();
    await restartWithRepairRetry(deps, options.signal);
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

export async function selectMihomoStrategy(deps: AppActionDeps, strategy: StrategyKey): Promise<AppSnapshot> {
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
  options: TestNodeOptions = {}
): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.read();
  if (deps.lifecycle.getStatus() !== 'running') {
    await startWithRepairRetry(deps);
  }
  const delay = await deps.createMihomoApi({ secret: settings.controllerSecret }).testNodeDelay(name);
  await options.onDelayTested?.(name, delay);
  return deps.createSnapshot();
}

export async function testAllMihomoNodes(deps: AppActionDeps, options: TestAllNodesOptions = {}): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.read();
  if (deps.lifecycle.getStatus() !== 'running') {
    await startWithRepairRetry(deps);
  }
  await deps.createMihomoApi({ secret: settings.controllerSecret }).testAllNodes({
    signal: options.signal,
    onNodeTested: async (node) => {
      await options.onNodeTested?.(node);
      await options.onProgress?.();
    }
  });
  return deps.createSnapshot();
}

export async function closeMihomoConnections(deps: AppActionDeps): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.read();
  if (deps.lifecycle.getStatus() === 'running') {
    await deps.createMihomoApi({ secret: settings.controllerSecret }).closeConnections();
  }
  return deps.createSnapshot();
}

async function startWithRepairRetry(
  deps: Pick<AppActionDeps, 'lifecycle' | 'runtime'>,
  signal?: AbortSignal
): Promise<void> {
  if (deps.runtime) {
    await deps.runtime.start(signal);
    return;
  }
  try {
    await deps.lifecycle.start(signal);
  } catch {
    signal?.throwIfAborted();
    await deps.lifecycle.repair(signal).catch(() => undefined);
    signal?.throwIfAborted();
    await deps.lifecycle.start(signal);
  }
}

async function restartWithRepairRetry(
  deps: Pick<AppActionDeps, 'lifecycle' | 'runtime'>,
  signal?: AbortSignal
): Promise<void> {
  if (deps.runtime) {
    await deps.runtime.restart(signal);
    return;
  }
  await deps.lifecycle.stop();
  signal?.throwIfAborted();
  await startWithRepairRetry(deps, signal);
}
