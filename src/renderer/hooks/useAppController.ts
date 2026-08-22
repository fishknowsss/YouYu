import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type {
  AppSettingsInput,
  AppSnapshot,
  MihomoMode,
  OperationRequest,
  StrategyKey,
  TrafficRegistrationInput
} from '../../shared/ipc';
import {
  ActionTimeoutError,
  createOperationRequestTracker,
  getActionErrorMessage,
  startEasyProxy,
  withTimeout
} from '../appActions';
import { createAppSnapshotStore } from '../appSnapshotStore';
import type { PageKey, UsageMode } from '../components/AppShell';
import { createOperationRequest } from '../operationRequest';
import { useAdvancedModeShortcut } from './useAdvancedModeShortcut';

const emptySnapshot: AppSnapshot = {
  status: 'stopped',
  currentNode: '自动选择',
  nodes: [],
  nodeHealth: {
    nodeName: '自动选择',
    delayStatus: 'untested',
    availability: {
      status: 'untested',
      totalCount: 15
    }
  },
  strategies: [
    { key: 'auto', label: '自动', target: '自动选择', active: true },
    { key: 'fallback', label: '故障转移', target: '故障转移', active: false },
    { key: 'load-balance', label: '均衡', target: '负载均衡', active: false },
    { key: 'direct', label: '直连', target: 'DIRECT', active: false }
  ],
  mode: 'rule',
  strategy: 'auto',
  ruleProfile: 'ruleset',
  features: {
    systemProxyEnabled: true,
    dnsEnhanced: true,
    snifferEnabled: true,
    tunEnabled: false,
    strictRouteEnabled: true,
    allowLan: false,
    subscriptionRefreshIntervalHours: 12
  },
  runtime: {
    activeConnections: 0,
    uploadTotal: 0,
    downloadTotal: 0
  },
  traffic: {
    totalUpload: 0,
    totalDownload: 0,
    todayUpload: 0,
    todayDownload: 0,
    pendingUpload: 0,
    pendingDownload: 0,
    nodeUsage: {},
    reportStatus: 'idle'
  },
  subscriptionUrl: '',
  subscriptionRevision: 0,
  update: {
    currentVersion: '0.0.0',
    buildChannel: 'standard',
    updateChannel: 'latest',
    status: 'idle'
  },
  diagnostics: {
    logs: []
  }
};

const easyStartSettings: AppSettingsInput = {
  mode: 'rule',
  strategy: 'auto',
  systemProxyEnabled: true,
  dnsEnhanced: true,
  snifferEnabled: true,
  tunEnabled: false,
  strictRouteEnabled: true,
  allowLan: false,
  subscriptionRefreshIntervalHours: 12
};

const actionTimeoutMs = 120000;
const nodeTestActionTimeoutMs = 10 * 60 * 1000;

type AppApi = NonNullable<Window['youyu']>;

type ActionOptions = {
  workingMessage?: string;
  timeoutMs?: number;
  timeoutLabel?: string;
  messageSink?: Dispatch<SetStateAction<string>>;
  cancellable?: boolean;
  recoverSnapshotOnError?: boolean;
  cancelNodeTestsOnDispose?: boolean;
  clearMessage?: boolean;
  onTimeout?: (api: AppApi) => void;
};

export type AppController = ReturnType<typeof useAppController>;

export function useAppController() {
  const [page, setPage] = useState<PageKey>(readInitialPage);
  const [usageMode, setUsageMode] = useState<UsageMode>(readUsageMode);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [message, setMessage] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const [testingAllNodes, setTestingAllNodes] = useState(false);
  const [switchingNode, setSwitchingNode] = useState('');
  const [snapshotState, setSnapshotState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [registrationSwitchOpen, setRegistrationSwitchOpen] = useState(false);
  const snapshotStore = useMemo(
    () =>
      createAppSnapshotStore(emptySnapshot, (next) => {
        setSnapshot(next);
        setSnapshotState('ready');
      }),
    []
  );
  const restoreRegistrationEntryFocusRef = useRef(false);
  const initialSnapshotPromiseRef = useRef<Promise<AppSnapshot> | undefined>(undefined);
  const nodeSelectionGenerationRef = useRef(0);
  const nodeSelectionNoticeIdRef = useRef<number | undefined>(undefined);
  const switchingNodeRef = useRef('');
  const advancedUnlockClicksRef = useRef(0);
  const activeOperationRequestsRef = useRef(new Map<string, AppApi>());
  const canceledOperationRequestsRef = useRef(new Set<string>());
  const activeNodeTestApisRef = useRef(new Set<AppApi>());
  const activeTaskControllersRef = useRef(new Set<AbortController>());
  const registrationInFlightRef = useRef(false);
  const registrationSwitchOpenRef = useRef(registrationSwitchOpen);
  const registered = Boolean(snapshot.trafficIdentity);

  useEffect(() => {
    registrationSwitchOpenRef.current = registrationSwitchOpen;
  }, [registrationSwitchOpen]);

  const commitSnapshot = useCallback(
    (next: AppSnapshot, expectedGeneration?: number): boolean => snapshotStore.commit(next, expectedGeneration),
    [snapshotStore]
  );

  const cancelOperationOnce = useCallback(async (api: AppApi, request?: OperationRequest): Promise<boolean> => {
    if (!request || canceledOperationRequestsRef.current.has(request.requestId)) return false;
    canceledOperationRequestsRef.current.add(request.requestId);
    return api.cancelOperation(request.requestId).catch(() => false);
  }, []);

  useEffect(() => {
    snapshotStore.mount();
    return () => snapshotStore.unmount();
  }, [snapshotStore]);

  const runAction = useCallback(
    async (
      action: (api: AppApi, request?: OperationRequest) => Promise<AppSnapshot>,
      doneMessage: string,
      options: ActionOptions = {}
    ): Promise<boolean> => {
      const {
        workingMessage = '',
        timeoutMs = actionTimeoutMs,
        timeoutLabel = workingMessage.replace(/中$/, '') || '操作',
        messageSink,
        cancellable = false,
        recoverSnapshotOnError = true,
        cancelNodeTestsOnDispose = false,
        clearMessage = true,
        onTimeout
      } = options;
      const api = window.youyu;
      if (!api) {
        if (messageSink) messageSink('核心接口未加载');
        else setMessage('核心接口未加载');
        return false;
      }

      const request = cancellable ? createOperationRequest() : undefined;
      const taskController = new AbortController();
      activeTaskControllersRef.current.add(taskController);
      if (request) activeOperationRequestsRef.current.set(request.requestId, api);
      if (cancelNodeTestsOnDispose) activeNodeTestApisRef.current.add(api);
      const snapshotGeneration = snapshotStore.getGeneration();
      setBusy(true);
      setBusyLabel(workingMessage);
      if (clearMessage) {
        if (messageSink) messageSink('');
        else setMessage('');
      }
      try {
        const actionPromise = action(api, request);
        const next = await withTimeout(
          actionPromise,
          timeoutMs,
          timeoutLabel,
          () => onTimeout?.(api),
          taskController.signal
        );
        if (!snapshotStore.isMounted()) return false;
        commitSnapshot(next, snapshotGeneration);
        if (messageSink) messageSink(doneMessage);
        else setMessage(doneMessage);
        return true;
      } catch (error) {
        if (!snapshotStore.isMounted() || taskController.signal.aborted) return false;
        if (error instanceof ActionTimeoutError && request) {
          await cancelOperationOnce(api, request);
        }
        if (!snapshotStore.isMounted()) return false;
        if (recoverSnapshotOnError) {
          const next = await api.getSnapshot().catch(() => snapshotStore.getSnapshot());
          if (!snapshotStore.isMounted()) return false;
          commitSnapshot(next, snapshotGeneration);
        }
        const errorMessage = getActionErrorMessage(error);
        if (messageSink) messageSink(errorMessage);
        else setMessage(errorMessage);
        return false;
      } finally {
        activeTaskControllersRef.current.delete(taskController);
        if (request) {
          activeOperationRequestsRef.current.delete(request.requestId);
          canceledOperationRequestsRef.current.delete(request.requestId);
        }
        if (cancelNodeTestsOnDispose) activeNodeTestApisRef.current.delete(api);
        if (snapshotStore.isMounted()) {
          setBusy(false);
          setBusyLabel('');
        }
      }
    },
    [cancelOperationOnce, commitSnapshot, snapshotStore]
  );

  const loadInitialSnapshot = useCallback(
    async (retry = false) => {
      const api = window.youyu;
      if (!api) {
        if (snapshotStore.isMounted()) setSnapshotState('error');
        return;
      }
      if (retry) initialSnapshotPromiseRef.current = undefined;
      if (snapshotStore.isMounted()) setSnapshotState('loading');
      try {
        const next = await (initialSnapshotPromiseRef.current ??= api.getSnapshot());
        commitSnapshot(next);
      } catch {
        initialSnapshotPromiseRef.current = undefined;
        if (snapshotStore.isMounted()) setSnapshotState('error');
      }
    },
    [commitSnapshot, snapshotStore]
  );

  useEffect(() => {
    void loadInitialSnapshot();
  }, [loadInitialSnapshot]);

  const retrySnapshot = useCallback(() => void loadInitialSnapshot(true), [loadInitialSnapshot]);

  useEffect(() => {
    const dispose = window.youyu?.onSnapshotUpdated((next) => commitSnapshot(next));
    return dispose;
  }, [commitSnapshot]);

  useEffect(
    () => () => {
      for (const controller of activeTaskControllersRef.current) {
        controller.abort(new Error('operation canceled'));
      }
      activeTaskControllersRef.current.clear();
      for (const [requestId, api] of activeOperationRequestsRef.current) {
        void cancelOperationOnce(api, { requestId });
      }
      activeOperationRequestsRef.current.clear();
      for (const api of activeNodeTestApisRef.current) {
        void api.cancelNodeTests().catch(() => undefined);
      }
      activeNodeTestApisRef.current.clear();
    },
    [cancelOperationOnce]
  );

  useEffect(() => scheduleTransientMessageClear(message, setMessage), [message]);
  useEffect(() => scheduleTransientMessageClear(settingsMessage, setSettingsMessage), [settingsMessage]);

  useEffect(() => {
    const notice = snapshot.nodeSelectionNotice;
    if (!notice || notice.id === nodeSelectionNoticeIdRef.current) return;
    nodeSelectionNoticeIdRef.current = notice.id;
    setMessage(notice.message);
  }, [snapshot.nodeSelectionNotice]);

  useEffect(() => {
    if (registrationSwitchOpen || !restoreRegistrationEntryFocusRef.current) return;
    restoreRegistrationEntryFocusRef.current = false;
    document.querySelector<HTMLButtonElement>('.version-chip')?.focus();
  }, [registrationSwitchOpen]);

  const changeUsageMode = useCallback((next: UsageMode) => {
    advancedUnlockClicksRef.current = 0;
    setUsageMode(next);
    if (next === 'easy') setPage('home');
  }, []);

  useAdvancedModeShortcut(usageMode, changeUsageMode);

  const quickStart = useCallback(
    async (subscriptionUrl: string) => {
      const api = window.youyu;
      if (!api) {
        setMessage('核心接口未加载');
        return;
      }

      const currentSnapshot = snapshotStore.getSnapshot();
      const nextUrl = subscriptionUrl.trim() || currentSnapshot.subscriptionUrl.trim();
      if (!nextUrl) {
        setMessage('先填写订阅地址');
        return;
      }

      setBusy(true);
      setBusyLabel('启动中');
      setMessage('');
      const taskController = new AbortController();
      const quickStartController = new AbortController();
      const forwardTaskAbort = () => quickStartController.abort(taskController.signal.reason);
      taskController.signal.addEventListener('abort', forwardTaskAbort, { once: true });
      activeTaskControllersRef.current.add(taskController);
      activeNodeTestApisRef.current.add(api);
      const requestTracker = createOperationRequestTracker((request, previous) => {
        if (previous) activeOperationRequestsRef.current.delete(previous.requestId);
        activeOperationRequestsRef.current.set(request.requestId, api);
      });
      const snapshotGeneration = snapshotStore.getGeneration();
      try {
        const saveRequest = requestTracker.next();
        await withTimeout(
          api.saveSettings(
            {
              ...easyStartSettings,
              ...(currentSnapshot.remoteSubscriptionUrl ? {} : { subscriptionUrl: nextUrl })
            },
            'easy-start',
            saveRequest
          ),
          actionTimeoutMs,
          '保存',
          () => quickStartController.abort(new Error('operation canceled')),
          taskController.signal
        );
        const next = await withTimeout(
          startEasyProxy(api, requestTracker, quickStartController.signal),
          actionTimeoutMs,
          '启动',
          () => quickStartController.abort(new Error('operation canceled')),
          taskController.signal
        );
        if (!snapshotStore.isMounted()) return;
        commitSnapshot(next, snapshotGeneration);
        setMessage('已启动');
      } catch (error) {
        if (!snapshotStore.isMounted() || taskController.signal.aborted) return;
        if (error instanceof ActionTimeoutError) {
          await cancelOperationOnce(api, requestTracker.current);
          await api.cancelNodeTests().catch(() => undefined);
        }
        if (!snapshotStore.isMounted()) return;
        const next = await api.getSnapshot().catch(() => snapshotStore.getSnapshot());
        if (!snapshotStore.isMounted()) return;
        commitSnapshot(next, snapshotGeneration);
        setMessage(getActionErrorMessage(error));
      } finally {
        taskController.signal.removeEventListener('abort', forwardTaskAbort);
        activeTaskControllersRef.current.delete(taskController);
        activeNodeTestApisRef.current.delete(api);
        if (requestTracker.current) {
          activeOperationRequestsRef.current.delete(requestTracker.current.requestId);
          canceledOperationRequestsRef.current.delete(requestTracker.current.requestId);
        }
        if (snapshotStore.isMounted()) {
          setBusy(false);
          setBusyLabel('');
        }
      }
    },
    [cancelOperationOnce, commitSnapshot, snapshotStore]
  );

  const testAllNodes = useCallback(async () => {
    if (!snapshotStore.isMounted()) return;
    setTestingAllNodes(true);
    try {
      await runAction((api) => api.testAllNodes(), '测速完成', {
        workingMessage: '测速中',
        timeoutMs: nodeTestActionTimeoutMs,
        timeoutLabel: '测速',
        cancelNodeTestsOnDispose: true,
        onTimeout: (api) => void api.cancelNodeTests().catch(() => undefined)
      });
    } finally {
      if (snapshotStore.isMounted()) setTestingAllNodes(false);
    }
  }, [runAction, snapshotStore]);

  const cancelNodeTests = useCallback(async () => {
    setMessage('停止中');
    await runAction((api) => api.cancelNodeTests(), '已停止', {
      timeoutLabel: '停止测速',
      clearMessage: false
    });
    if (snapshotStore.isMounted()) setTestingAllNodes(false);
  }, [runAction, snapshotStore]);

  const selectNode = useCallback(
    async (name: string) => {
      const api = window.youyu;
      if (!api) {
        setMessage('核心接口未加载');
        return;
      }
      if (switchingNodeRef.current) return;

      const selectionGeneration = ++nodeSelectionGenerationRef.current;
      const taskController = new AbortController();
      activeTaskControllersRef.current.add(taskController);
      switchingNodeRef.current = name;
      setSwitchingNode(name);
      setMessage('');
      try {
        const next = await withTimeout(
          api.selectNode(name),
          actionTimeoutMs,
          '切换节点',
          undefined,
          taskController.signal
        );
        if (!snapshotStore.isMounted() || selectionGeneration !== nodeSelectionGenerationRef.current) return;
        commitSnapshot(next);
        const activeNode = next.nodes.find((node) => node.active)?.name || next.currentNode;
        const selected = activeNode === name || next.currentNode === name;
        setMessage(selected ? '已切换' : activeNode ? `已切至${activeNode}` : '切换失败');
      } catch (error) {
        if (
          !snapshotStore.isMounted() ||
          taskController.signal.aborted ||
          selectionGeneration !== nodeSelectionGenerationRef.current
        )
          return;
        const next = await api.getSnapshot().catch(() => snapshotStore.getSnapshot());
        if (!snapshotStore.isMounted() || selectionGeneration !== nodeSelectionGenerationRef.current) return;
        commitSnapshot(next);
        setMessage(getActionErrorMessage(error));
      } finally {
        activeTaskControllersRef.current.delete(taskController);
        if (selectionGeneration === nodeSelectionGenerationRef.current) {
          switchingNodeRef.current = '';
          if (snapshotStore.isMounted()) setSwitchingNode('');
        }
      }
    },
    [commitSnapshot, snapshotStore]
  );

  const exportDiagnostics = useCallback(async () => {
    const api = window.youyu;
    if (!api) {
      setSettingsMessage('核心接口未加载');
      return;
    }

    const taskController = new AbortController();
    activeTaskControllersRef.current.add(taskController);
    setBusy(true);
    setBusyLabel('导出中');
    setSettingsMessage('');
    try {
      const result = await withTimeout(
        api.exportDiagnostics(),
        actionTimeoutMs,
        '导出',
        undefined,
        taskController.signal
      );
      if (snapshotStore.isMounted() && !result.canceled) setSettingsMessage('已导出');
    } catch (error) {
      if (snapshotStore.isMounted() && !taskController.signal.aborted) {
        setSettingsMessage(error instanceof ActionTimeoutError ? getActionErrorMessage(error) : '导出失败');
      }
    } finally {
      activeTaskControllersRef.current.delete(taskController);
      if (snapshotStore.isMounted()) {
        setBusy(false);
        setBusyLabel('');
      }
    }
  }, [snapshotStore]);

  const handleAdvancedUnlockClick = useCallback(() => {
    advancedUnlockClicksRef.current += 1;
    if (advancedUnlockClicksRef.current >= 7) changeUsageMode('advanced');
  }, [changeUsageMode]);

  const openRegistrationSwitch = useCallback(() => {
    setMessage('');
    restoreRegistrationEntryFocusRef.current = true;
    setRegistrationSwitchOpen(true);
  }, []);

  const closeRegistrationSwitch = useCallback(() => setRegistrationSwitchOpen(false), []);

  const registerTrafficIdentity = useCallback(
    async (input: TrafficRegistrationInput) => {
      if (registrationInFlightRef.current) return;
      registrationInFlightRef.current = true;
      try {
        const switchingUser = Boolean(snapshotStore.getSnapshot().trafficIdentity) && registrationSwitchOpenRef.current;
        const success = await runAction((api) => api.registerTrafficIdentity(input), '', {
          workingMessage: switchingUser ? '切换中' : '登记中',
          timeoutLabel: switchingUser ? '切换用户' : '登记'
        });
        if (success && switchingUser && snapshotStore.isMounted()) setRegistrationSwitchOpen(false);
      } finally {
        registrationInFlightRef.current = false;
      }
    },
    [runAction, snapshotStore]
  );

  const start = useCallback(
    () =>
      void runAction((api, request) => api.start(request), '已启动', {
        workingMessage: '启动中',
        timeoutLabel: '启动',
        cancellable: true
      }),
    [runAction]
  );
  const stop = useCallback(
    () =>
      void runAction((api) => api.stop(), '已停止', {
        workingMessage: '停止中',
        timeoutLabel: '停止'
      }),
    [runAction]
  );
  const repair = useCallback(
    () =>
      void runAction((api, request) => api.repair(request), '已修复', {
        workingMessage: '修复中',
        timeoutLabel: '修复',
        cancellable: true
      }),
    [runAction]
  );
  const setMode = useCallback(
    (mode: MihomoMode) => void runAction((api) => api.setMode(mode), '模式已切换'),
    [runAction]
  );
  const selectStrategy = useCallback(
    (strategy: StrategyKey) =>
      void (strategy === 'auto'
        ? runAction((api, request) => api.selectBestAutoNode(request), '已切换', {
            workingMessage: '选择中',
            timeoutLabel: '切换',
            cancellable: true
          })
        : runAction((api) => api.selectStrategy(strategy), '已切换')),
    [runAction]
  );
  const openNodes = useCallback(() => setPage('nodes'), []);
  const testNode = useCallback((name: string) => void runAction((api) => api.testNode(name), '测速完成'), [runAction]);
  const updateSubscription = useCallback(
    () =>
      void runAction((api, request) => api.updateSubscription(request), '已更新', {
        workingMessage: '更新中',
        timeoutLabel: '更新',
        cancellable: true
      }),
    [runAction]
  );
  const settingsRepair = useCallback(
    () =>
      void runAction((api, request) => api.repair(request), '已修复', {
        workingMessage: '修复中',
        timeoutLabel: '修复',
        messageSink: setSettingsMessage,
        cancellable: true
      }),
    [runAction]
  );
  const saveSettings = useCallback(
    (settings: AppSettingsInput) =>
      void runAction((api, request) => api.saveSettings(settings, 'advanced-save', request), '已保存', {
        workingMessage: '保存中',
        timeoutLabel: '保存',
        messageSink: setSettingsMessage,
        cancellable: true
      }),
    [runAction]
  );
  const syncRemoteConfig = useCallback(
    () =>
      void runAction((api, request) => api.syncRemoteConfig(request), '已同步', {
        workingMessage: '同步中',
        timeoutLabel: '同步',
        messageSink: setSettingsMessage,
        cancellable: true
      }),
    [runAction]
  );
  const acknowledgeUserNotice = useCallback(
    (revision: number) =>
      runAction((api) => api.acknowledgeUserNotice(revision), '', {
        timeoutLabel: '确认信息',
        clearMessage: false
      }),
    [runAction]
  );
  const checkForUpdates = useCallback(
    () =>
      void runAction((api) => api.checkForUpdates(), '', {
        workingMessage: '检查中',
        timeoutLabel: '检查更新',
        messageSink: setSettingsMessage
      }),
    [runAction]
  );
  const handleInstallUpdate = useCallback(
    (messageSink?: Dispatch<SetStateAction<string>>) =>
      void runAction((api) => api.installUpdate(), '', {
        workingMessage: '确认新版中',
        timeoutLabel: '安装更新',
        messageSink
      }),
    [runAction]
  );
  const installUpdate = useCallback(() => handleInstallUpdate(), [handleInstallUpdate]);
  const installSettingsUpdate = useCallback(() => handleInstallUpdate(setSettingsMessage), [handleInstallUpdate]);

  return {
    page,
    setPage,
    usageMode,
    snapshot,
    busy,
    busyLabel,
    message,
    settingsMessage,
    testingAllNodes,
    switchingNode,
    snapshotLoaded: snapshotState === 'ready',
    snapshotState,
    retrySnapshot,
    registered,
    registrationSwitchOpen,
    changeUsageMode,
    handleAdvancedUnlockClick,
    openRegistrationSwitch,
    closeRegistrationSwitch,
    registerTrafficIdentity,
    acknowledgeUserNotice,
    quickStart,
    start,
    stop,
    repair,
    setMode,
    selectStrategy,
    openNodes,
    selectNode,
    testNode,
    testAllNodes,
    cancelNodeTests,
    updateSubscription,
    settingsRepair,
    saveSettings,
    syncRemoteConfig,
    checkForUpdates,
    installUpdate,
    installSettingsUpdate,
    exportDiagnostics
  };
}

const transientMessages = new Set([
  '已启动',
  '已停止',
  '已修复',
  '已切换',
  '已更新',
  '已保存',
  '已同步',
  '已导出',
  '测速完成',
  '模式已切换',
  '已登记'
]);

function scheduleTransientMessageClear(
  message: string,
  setMessage: Dispatch<SetStateAction<string>>
): (() => void) | undefined {
  if (!transientMessages.has(message)) return undefined;
  const timer = window.setTimeout(() => {
    setMessage((current) => (current === message ? '' : current));
  }, 3000);
  return () => window.clearTimeout(timer);
}

function readUsageMode(): UsageMode {
  return new URLSearchParams(window.location.search).get('mode') === 'advanced' ? 'advanced' : 'easy';
}

function readInitialPage(): PageKey {
  const page = new URLSearchParams(window.location.search).get('page');
  if (page === 'nodes' || page === 'test' || page === 'petPreview' || page === 'settings') return page;
  return 'home';
}
