import type { OperationRequest } from '../shared/ipc';
import { ActionTimeoutError, getActionErrorMessage, withTimeout } from './appActions';
import type { AppSnapshotStore } from './appSnapshotStore';
import { createOperationRequest } from './operationRequest';

type OperationApi<Snapshot> = {
  getSnapshot: () => Promise<Snapshot>;
  cancelOperation: (requestId: string) => Promise<boolean>;
  cancelNodeTests: () => Promise<unknown>;
};

export type OperationAction<Api, Snapshot> = (api: Api, request?: OperationRequest) => Promise<Snapshot>;

export type OperationOptions<Api> = {
  workingMessage?: string;
  timeoutMs?: number;
  timeoutLabel?: string;
  messageSink?: (value: string) => void;
  cancellable?: boolean;
  recoverSnapshotOnError?: boolean;
  cancelNodeTestsOnDispose?: boolean;
  clearMessage?: boolean;
  onTimeout?: (api: Api) => void;
};

type OperationRunnerDependencies<Snapshot, Api> = {
  getApi: () => Api | undefined;
  snapshotStore: AppSnapshotStore<Snapshot>;
  createRequest?: () => OperationRequest;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string) => void;
  setMessage: (value: string) => void;
  formatError?: (error: unknown) => string;
  defaultTimeoutMs: number;
};

export function createOperationRunner<Snapshot, Api extends OperationApi<Snapshot>>(
  dependencies: OperationRunnerDependencies<Snapshot, Api>
) {
  const activeRequests = new Map<string, Api>();
  const canceledRequests = new Set<string>();
  const activeNodeTestApis = new Set<Api>();
  const activeTasks = new Set<AbortController>();
  const makeRequest = dependencies.createRequest ?? createOperationRequest;
  const formatError = dependencies.formatError ?? getActionErrorMessage;

  async function cancelOperationOnce(api: Api, request?: OperationRequest): Promise<boolean> {
    if (!request || canceledRequests.has(request.requestId)) return false;
    canceledRequests.add(request.requestId);
    return api.cancelOperation(request.requestId).catch(() => false);
  }

  function trackRequest(api: Api, request: OperationRequest, previous?: OperationRequest): void {
    if (previous) activeRequests.delete(previous.requestId);
    activeRequests.set(request.requestId, api);
  }

  function untrackRequest(request?: OperationRequest): void {
    if (!request) return;
    activeRequests.delete(request.requestId);
    canceledRequests.delete(request.requestId);
  }

  function trackTask(controller: AbortController): void {
    activeTasks.add(controller);
  }

  function untrackTask(controller: AbortController): void {
    activeTasks.delete(controller);
  }

  function trackNodeTests(api: Api): void {
    activeNodeTestApis.add(api);
  }

  function untrackNodeTests(api: Api): void {
    activeNodeTestApis.delete(api);
  }

  async function run(
    action: OperationAction<Api, Snapshot>,
    doneMessage: string,
    options: OperationOptions<Api> = {}
  ): Promise<boolean> {
    const {
      workingMessage = '',
      timeoutMs = dependencies.defaultTimeoutMs,
      timeoutLabel = workingMessage.replace(/中$/, '') || '操作',
      messageSink,
      cancellable = false,
      recoverSnapshotOnError = true,
      cancelNodeTestsOnDispose = false,
      clearMessage = true,
      onTimeout
    } = options;
    const api = dependencies.getApi();
    if (!api) {
      if (messageSink) messageSink('核心接口未加载');
      else dependencies.setMessage('核心接口未加载');
      return false;
    }

    const request = cancellable ? makeRequest() : undefined;
    const taskController = new AbortController();
    trackTask(taskController);
    if (request) trackRequest(api, request);
    if (cancelNodeTestsOnDispose) trackNodeTests(api);
    const snapshotGeneration = dependencies.snapshotStore.getGeneration();
    dependencies.setBusy(true);
    dependencies.setBusyLabel(workingMessage);
    if (clearMessage) {
      if (messageSink) messageSink('');
      else dependencies.setMessage('');
    }
    try {
      const next = await withTimeout(
        action(api, request),
        timeoutMs,
        timeoutLabel,
        () => onTimeout?.(api),
        taskController.signal
      );
      if (!dependencies.snapshotStore.isMounted()) return false;
      dependencies.snapshotStore.commit(next, snapshotGeneration);
      if (messageSink) messageSink(doneMessage);
      else dependencies.setMessage(doneMessage);
      return true;
    } catch (error) {
      if (!dependencies.snapshotStore.isMounted() || taskController.signal.aborted) return false;
      if (error instanceof ActionTimeoutError && request) {
        await cancelOperationOnce(api, request);
      }
      if (!dependencies.snapshotStore.isMounted()) return false;
      if (recoverSnapshotOnError) {
        const next = await api.getSnapshot().catch(() => dependencies.snapshotStore.getSnapshot());
        if (!dependencies.snapshotStore.isMounted()) return false;
        dependencies.snapshotStore.commit(next, snapshotGeneration);
      }
      const errorMessage = formatError(error);
      if (messageSink) messageSink(errorMessage);
      else dependencies.setMessage(errorMessage);
      return false;
    } finally {
      untrackTask(taskController);
      untrackRequest(request);
      if (cancelNodeTestsOnDispose) untrackNodeTests(api);
      if (dependencies.snapshotStore.isMounted()) {
        dependencies.setBusy(false);
        dependencies.setBusyLabel('');
      }
    }
  }

  function dispose(): void {
    for (const controller of activeTasks) {
      controller.abort(new Error('operation canceled'));
    }
    activeTasks.clear();
    for (const [requestId, api] of activeRequests) {
      void cancelOperationOnce(api, { requestId });
    }
    activeRequests.clear();
    for (const api of activeNodeTestApis) {
      void api.cancelNodeTests().catch(() => undefined);
    }
    activeNodeTestApis.clear();
  }

  return {
    run,
    cancelOperationOnce,
    trackRequest,
    untrackRequest,
    trackTask,
    untrackTask,
    trackNodeTests,
    untrackNodeTests,
    dispose,
    getTrackingCounts: () => ({
      tasks: activeTasks.size,
      requests: activeRequests.size,
      canceledRequests: canceledRequests.size,
      nodeTests: activeNodeTestApis.size
    })
  };
}
