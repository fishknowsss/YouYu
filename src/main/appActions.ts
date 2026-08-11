import type {
  AppSettingsInput,
  AppSnapshot,
  MihomoMode,
  ProxyNode,
  RemoteControlConfig,
  RuleProfile,
  SettingsSaveIntent,
  StrategyKey
} from '../shared/ipc';
import type { LifecycleController } from './lifecycle';
import type { MihomoApiClient } from './mihomo/api';
import { runRuntimeOperationWithSafeRetry } from './runtimeRecoveryPolicy';
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
  remoteConfig?: {
    readSnapshot: () => Promise<{
      binding?: string;
      ready: boolean;
      canEditManagedConfig: boolean;
      config?: RemoteControlConfig;
    }>;
    update: (
      input: { subscriptionUrl?: string | null; ruleProfile?: RuleProfile },
      signal?: AbortSignal
    ) => Promise<RemoteControlConfig | undefined>;
    apply: (config?: RemoteControlConfig) => Promise<void>;
  };
  createMihomoApi: CreateMihomoApi;
  createSnapshot: () => Promise<AppSnapshot>;
};

export async function saveSubscriptionSettings(
  deps: Pick<AppActionDeps, 'settingsStore' | 'lifecycle' | 'runtime' | 'remoteConfig' | 'createSnapshot'>,
  settings: AppSettingsInput | string,
  options: { signal?: AbortSignal; intent?: SettingsSaveIntent } = {}
): Promise<AppSnapshot> {
  options.signal?.throwIfAborted();
  const input = typeof settings === 'string' ? { subscriptionUrl: settings } : settings;
  const next = {
    ...input,
    subscriptionUrl: typeof input.subscriptionUrl === 'string' ? input.subscriptionUrl.trim() : undefined
  };

  const managedByCloud = await publishManagedSettings(
    deps.remoteConfig,
    next,
    options.intent ?? 'advanced-save',
    options.signal
  );
  options.signal?.throwIfAborted();
  const localSettings = managedByCloud ? omitManagedSettings(next) : next;
  await deps.settingsStore.update(localSettings);
  options.signal?.throwIfAborted();
  if (deps.lifecycle.getStatus() === 'running') {
    await restartWithSafeRetry(deps, options.signal);
  }
  return deps.createSnapshot();
}

async function publishManagedSettings(
  remoteConfig: AppActionDeps['remoteConfig'],
  input: AppSettingsInput,
  intent: SettingsSaveIntent,
  signal?: AbortSignal
): Promise<boolean> {
  if (!remoteConfig || intent !== 'advanced-save') return false;
  const hasManagedInput = typeof input.subscriptionUrl === 'string' || typeof input.ruleProfile !== 'undefined';
  if (!hasManagedInput) return false;
  const snapshot = await remoteConfig.readSnapshot();
  signal?.throwIfAborted();
  if (!snapshot.binding) return false;
  if (!snapshot.ready) throw new Error('请先同步云端配置');
  if (!snapshot.canEditManagedConfig) throw new Error('此账号未获配置修改权限');
  const current = snapshot.config;

  const update: { subscriptionUrl?: string | null; ruleProfile?: RuleProfile } = {};
  if (typeof input.subscriptionUrl === 'string') {
    const desiredSubscription = input.subscriptionUrl.trim();
    if (desiredSubscription !== (current?.subscriptionUrl ?? '')) {
      update.subscriptionUrl = desiredSubscription || null;
    }
  }
  if (input.ruleProfile && input.ruleProfile !== current?.ruleProfile) {
    update.ruleProfile = input.ruleProfile;
  }
  if (typeof update.subscriptionUrl === 'undefined' && typeof update.ruleProfile === 'undefined') return true;

  const applied = await remoteConfig.update(update, signal);
  signal?.throwIfAborted();
  await remoteConfig.apply(applied);
  return true;
}

function omitManagedSettings(input: AppSettingsInput): AppSettingsInput {
  const { subscriptionUrl: _subscriptionUrl, ruleProfile: _ruleProfile, ...localSettings } = input;
  return localSettings;
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
    await startWithSafeRetry(deps, options.signal);
    return deps.createSnapshot();
  }

  try {
    await deps.createMihomoApi({ secret: settings.controllerSecret }).updateProvider({ signal: options.signal });
  } catch (_error) {
    options.signal?.throwIfAborted();
    await restartWithSafeRetry(deps, options.signal);
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
    await startWithSafeRetry(deps);
  }
  const delay = await deps.createMihomoApi({ secret: settings.controllerSecret }).testNodeDelay(name);
  await options.onDelayTested?.(name, delay);
  return deps.createSnapshot();
}

export async function testAllMihomoNodes(deps: AppActionDeps, options: TestAllNodesOptions = {}): Promise<AppSnapshot> {
  const settings = await deps.settingsStore.read();
  if (deps.lifecycle.getStatus() !== 'running') {
    await startWithSafeRetry(deps);
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

async function startWithSafeRetry(
  deps: Pick<AppActionDeps, 'lifecycle' | 'runtime'>,
  signal?: AbortSignal
): Promise<void> {
  if (deps.runtime) {
    await deps.runtime.start(signal);
    return;
  }
  await runRuntimeOperationWithSafeRetry(() => deps.lifecycle.start(signal), { signal });
}

async function restartWithSafeRetry(
  deps: Pick<AppActionDeps, 'lifecycle' | 'runtime'>,
  signal?: AbortSignal
): Promise<void> {
  if (deps.runtime) {
    await deps.runtime.restart(signal);
    return;
  }
  await deps.lifecycle.stop();
  signal?.throwIfAborted();
  await startWithSafeRetry(deps, signal);
}
