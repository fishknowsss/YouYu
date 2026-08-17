import type { AppSnapshot, StrategyKey } from '../shared/ipc';
import { isExpectedOperationCancellation } from '../shared/operationCancellation';

export type ProxyStartSettings = {
  strategy: StrategyKey | string;
};

export type ProxyStartDeps = {
  throwIfAborted: (signal?: AbortSignal) => void;
  throwIfNetworkRepairInProgress: (allowDuringNetworkRepair?: boolean) => void;
  requireTrafficIdentity: () => Promise<void>;
  requestStartIntent: (requested?: number) => number;
  throwIfIntentCanceled: (generation: number) => void;
  isIntentCurrent: (generation: number) => boolean;
  syncRequiredRemoteConfig: (options: {
    signal?: AbortSignal;
    proxyUrl?: string;
    restartIfRunning?: boolean;
    intentGeneration?: number;
  }) => Promise<unknown>;
  startLifecycle: (signal: AbortSignal | undefined, intentGeneration: number) => Promise<void>;
  activatePending: () => Promise<unknown>;
  getRuntimeTrafficProxyUrl: () => string | undefined;
  stopLifecycle: () => Promise<void>;
  cancelIntent: () => void;
  createRefineSignal: () => AbortSignal | undefined;
  readSettings: () => Promise<ProxyStartSettings>;
  selectPreferredAutoNode: (options: { signal?: AbortSignal }) => Promise<string>;
  isExpectedCancellation: (error: unknown) => boolean;
  startTraffic: () => void;
  clearLastError: () => void;
  scheduleNodeHealthCheck: (delayMs?: number) => void;
  createSnapshot: () => Promise<AppSnapshot>;
  sendSnapshot: (snapshot: AppSnapshot) => void;
  appendLog: (line: string) => void;
  formatError: (error: unknown) => string;
  recordStartError: (error: unknown) => void;
};

export async function runProxyStartSequence(
  deps: ProxyStartDeps,
  signal?: AbortSignal,
  requestedIntentGeneration?: number
): Promise<AppSnapshot> {
  deps.throwIfAborted(signal);
  deps.throwIfNetworkRepairInProgress();
  if (requestedIntentGeneration !== undefined) deps.throwIfIntentCanceled(requestedIntentGeneration);
  await deps.requireTrafficIdentity();
  const intentGeneration = deps.requestStartIntent(requestedIntentGeneration);
  deps.throwIfIntentCanceled(intentGeneration);
  await deps.syncRequiredRemoteConfig({ signal });
  deps.throwIfAborted(signal);
  deps.throwIfIntentCanceled(intentGeneration);
  await deps.startLifecycle(signal, intentGeneration);
  deps.throwIfAborted(signal);
  deps.throwIfIntentCanceled(intentGeneration);
  await deps.activatePending();
  deps.throwIfIntentCanceled(intentGeneration);
  try {
    await deps.syncRequiredRemoteConfig({
      proxyUrl: deps.getRuntimeTrafficProxyUrl(),
      restartIfRunning: true,
      signal,
      intentGeneration
    });
  } catch (error) {
    deps.cancelIntent();
    await deps
      .stopLifecycle()
      .catch((stopError) => deps.appendLog(`云端配置未就绪后停止代理失败: ${deps.formatError(stopError)}`));
    throw error;
  }
  deps.throwIfAborted(signal);
  deps.throwIfIntentCanceled(intentGeneration);

  const startedSettings = await deps.readSettings();
  deps.startTraffic();
  deps.clearLastError();
  deps.scheduleNodeHealthCheck(0);
  const snapshot = await deps.createSnapshot();
  if (startedSettings.strategy === 'auto') {
    schedulePreferredAutoNodeRefinement(deps, { signal: deps.createRefineSignal(), intentGeneration });
  }
  return snapshot;
}

export function schedulePreferredAutoNodeRefinement(
  deps: Pick<
    ProxyStartDeps,
    | 'selectPreferredAutoNode'
    | 'isIntentCurrent'
    | 'throwIfIntentCanceled'
    | 'isExpectedCancellation'
    | 'appendLog'
    | 'formatError'
    | 'createSnapshot'
    | 'sendSnapshot'
    | 'recordStartError'
  >,
  options: { signal?: AbortSignal; intentGeneration: number }
): void {
  void refinePreferredAutoNodeAfterStart(deps, options).catch((error) => {
    if (deps.isExpectedCancellation(error) || isExpectedOperationCancellation(error)) return;
    if (!deps.isIntentCurrent(options.intentGeneration)) return;
    deps.appendLog(`启动后优选节点未完成，继续使用当前节点: ${deps.formatError(error)}`);
  });
}

async function refinePreferredAutoNodeAfterStart(
  deps: Pick<
    ProxyStartDeps,
    | 'selectPreferredAutoNode'
    | 'isIntentCurrent'
    | 'throwIfIntentCanceled'
    | 'isExpectedCancellation'
    | 'appendLog'
    | 'formatError'
    | 'createSnapshot'
    | 'sendSnapshot'
    | 'recordStartError'
  >,
  options: { signal?: AbortSignal; intentGeneration: number }
): Promise<void> {
  deps.throwIfIntentCanceled(options.intentGeneration);
  const selectedNode = await deps.selectPreferredAutoNode({ signal: options.signal });
  deps.throwIfIntentCanceled(options.intentGeneration);
  deps.appendLog(`已自动选择可用节点: ${selectedNode}`);
  const nextSnapshot = await deps.createSnapshot();
  if (!deps.isIntentCurrent(options.intentGeneration)) return;
  deps.sendSnapshot(nextSnapshot);
}
