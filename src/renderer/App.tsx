import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from 'react';
import type {
  AppSettingsInput,
  AppSnapshot,
  MihomoMode,
  OperationRequest,
  TrafficRegistrationInput
} from '../shared/ipc';
import { AppShell, type PageKey, type UsageMode } from './components/AppShell';
import { isActionErrorMessage } from './actionMessages';
import { Home } from './pages/Home';
import { NodeSelect } from './pages/NodeSelect';
import { Settings } from './pages/Settings';
import { TestPage } from './pages/TestPage';

const PetPreviewPage = lazy(async () => {
  const module = await import('./pages/PetPreviewPage');
  return { default: module.PetPreviewPage };
});

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
  ruleProfile: 'ruleset',
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

type ActionOptions = {
  workingMessage?: string;
  timeoutMs?: number;
  timeoutLabel?: string;
  messageSink?: (message: string) => void;
  cancellable?: boolean;
  onTimeout?: (api: NonNullable<Window['youyu']>) => void;
};

type OperationRequestTracker = {
  current?: OperationRequest;
  next: () => OperationRequest;
};

export function App() {
  const [page, setPage] = useState<PageKey>(readInitialPage);
  const [usageMode, setUsageMode] = useState<UsageMode>(readUsageMode);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [message, setMessage] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const [testingAllNodes, setTestingAllNodes] = useState(false);
  const testingAllNodesRef = useRef(false);
  const [switchingNode, setSwitchingNode] = useState('');
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [advancedUnlockClicks, setAdvancedUnlockClicks] = useState(0);
  const [registrationSwitchOpen, setRegistrationSwitchOpen] = useState(false);
  const restoreRegistrationEntryFocusRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  const snapshotGenerationRef = useRef(0);
  const nodeSelectionGenerationRef = useRef(0);
  const registered = Boolean(snapshot.trafficIdentity);

  function commitSnapshot(next: AppSnapshot, expectedGeneration?: number): boolean {
    if (expectedGeneration !== undefined && snapshotGenerationRef.current !== expectedGeneration) return false;
    snapshotGenerationRef.current += 1;
    snapshotRef.current = next;
    setSnapshot(next);
    setSnapshotLoaded(true);
    return true;
  }

  useEffect(() => {
    void runAction((api) => api.getSnapshot(), '');
    // The preload snapshot is fetched exactly once; later changes arrive through onSnapshotUpdated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const dispose = window.youyu?.onSnapshotUpdated((next) => {
      snapshotGenerationRef.current += 1;
      snapshotRef.current = next;
      setSnapshot(next);
      setSnapshotLoaded(true);
    });
    return dispose;
  }, []);

  useEffect(() => {
    testingAllNodesRef.current = testingAllNodes;
  }, [testingAllNodes]);

  useEffect(() => scheduleTransientMessageClear(message, setMessage), [message]);
  useEffect(() => scheduleTransientMessageClear(settingsMessage, setSettingsMessage), [settingsMessage]);

  useEffect(() => {
    if (registrationSwitchOpen || !restoreRegistrationEntryFocusRef.current) return;
    restoreRegistrationEntryFocusRef.current = false;
    document.querySelector<HTMLButtonElement>('.version-chip')?.focus();
  }, [registrationSwitchOpen]);

  useEffect(() => {
    const advancedSequence = [
      'ArrowUp',
      'ArrowUp',
      'ArrowDown',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowLeft',
      'ArrowRight',
      'KeyB',
      'KeyA'
    ];
    let sequenceIndex = 0;

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const expectedKey = advancedSequence[sequenceIndex];
      if (event.code === expectedKey) {
        sequenceIndex += 1;
        if (sequenceIndex === advancedSequence.length) {
          changeUsageMode(usageMode === 'advanced' ? 'easy' : 'advanced');
          sequenceIndex = 0;
        }
        return;
      }

      sequenceIndex = event.code === advancedSequence[0] ? 1 : 0;
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [usageMode]);

  async function runAction(
    action: (api: NonNullable<Window['youyu']>, request?: OperationRequest) => Promise<AppSnapshot>,
    doneMessage: string,
    options: ActionOptions = {}
  ): Promise<boolean> {
    const {
      workingMessage = '',
      timeoutMs = actionTimeoutMs,
      timeoutLabel = workingMessage.replace(/中$/, '') || '操作',
      messageSink,
      cancellable = false,
      onTimeout
    } = options;
    const api = window.youyu;
    if (!api) {
      if (messageSink) messageSink('核心接口未加载');
      else setMessage('核心接口未加载');
      return false;
    }

    const request = cancellable ? createOperationRequest() : undefined;
    const snapshotGeneration = snapshotGenerationRef.current;
    setBusy(true);
    setBusyLabel(workingMessage);
    if (messageSink) messageSink('');
    else setMessage('');
    try {
      const actionPromise = action(api, request);
      const next = await withTimeout(actionPromise, timeoutMs, timeoutLabel, () => {
        if (request) void api.cancelOperation(request.requestId).catch(() => false);
        onTimeout?.(api);
      });
      commitSnapshot(next, snapshotGeneration);
      if (messageSink) messageSink(doneMessage);
      else setMessage(doneMessage);
      return true;
    } catch (error) {
      if (error instanceof ActionTimeoutError && request) {
        await api.cancelOperation(request.requestId).catch(() => false);
      }
      const next = await api.getSnapshot().catch(() => snapshotRef.current);
      commitSnapshot(next, snapshotGeneration);
      const errorMessage = getActionErrorMessage(error);
      if (messageSink) messageSink(errorMessage);
      else setMessage(errorMessage);
      return false;
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  }

  function handleInstallUpdate(messageSink?: (message: string) => void) {
    void runAction((api) => api.installUpdate(), '', {
      workingMessage: '安装中',
      timeoutLabel: '安装更新',
      messageSink
    });
  }

  async function handleExportDiagnostics() {
    const api = window.youyu;
    if (!api) {
      setSettingsMessage('核心接口未加载');
      return;
    }

    setBusy(true);
    setBusyLabel('导出中');
    setSettingsMessage('');
    try {
      const result = await api.exportDiagnostics();
      if (!result.canceled) setSettingsMessage('已导出');
    } catch {
      setSettingsMessage('导出失败');
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  }

  async function quickStart(subscriptionUrl: string) {
    const api = window.youyu;
    if (!api) {
      setMessage('核心接口未加载');
      return;
    }

    const nextUrl = subscriptionUrl.trim() || snapshot.subscriptionUrl.trim();
    if (!nextUrl) {
      setMessage('先填写订阅地址');
      return;
    }

    setBusy(true);
    setBusyLabel('启动中');
    setMessage('');
    const requestTracker = createOperationRequestTracker();
    const quickStartController = new AbortController();
    const snapshotGeneration = snapshotGenerationRef.current;
    try {
      const saveRequest = requestTracker.next();
      await withTimeout(
        api.saveSettings(
          {
            ...easyStartSettings,
            ...(snapshot.remoteSubscriptionUrl ? {} : { subscriptionUrl: nextUrl })
          },
          saveRequest
        ),
        actionTimeoutMs,
        '保存',
        () => {
          quickStartController.abort(new Error('operation canceled'));
          void api.cancelOperation(saveRequest.requestId).catch(() => false);
        }
      );
      const next = await withTimeout(
        startEasyProxy(api, requestTracker, quickStartController.signal),
        actionTimeoutMs,
        '启动',
        () => {
          quickStartController.abort(new Error('operation canceled'));
          if (requestTracker.current) {
            void api.cancelOperation(requestTracker.current.requestId).catch(() => false);
          }
          void api.cancelNodeTests().catch(() => undefined);
        }
      );
      commitSnapshot(next, snapshotGeneration);
      setMessage('已启动');
    } catch (error) {
      if (error instanceof ActionTimeoutError && requestTracker.current) {
        await api.cancelOperation(requestTracker.current.requestId).catch(() => false);
        await api.cancelNodeTests().catch(() => undefined);
      }
      const next = await api.getSnapshot().catch(() => snapshotRef.current);
      commitSnapshot(next, snapshotGeneration);
      setMessage(getActionErrorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  }

  async function testAllNodes() {
    setTestingAllNodes(true);
    testingAllNodesRef.current = true;
    try {
      await runAction((api) => api.testAllNodes(), '测速完成', {
        workingMessage: '测速中',
        timeoutMs: nodeTestActionTimeoutMs,
        timeoutLabel: '测速',
        onTimeout: (api) => void api.cancelNodeTests().catch(() => undefined)
      });
    } finally {
      testingAllNodesRef.current = false;
      setTestingAllNodes(false);
    }
  }

  async function cancelNodeTests() {
    const api = window.youyu;
    if (!api) {
      setMessage('核心接口未加载');
      return;
    }

    setMessage('停止中');
    try {
      const next = await api.cancelNodeTests();
      commitSnapshot(next);
      setMessage('已停止');
    } catch (error) {
      setMessage(getActionErrorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel('');
      testingAllNodesRef.current = false;
      setTestingAllNodes(false);
    }
  }

  async function selectNode(name: string) {
    const api = window.youyu;
    if (!api) {
      setMessage('核心接口未加载');
      return;
    }

    const selectionGeneration = ++nodeSelectionGenerationRef.current;
    setSwitchingNode(name);
    setMessage('');
    try {
      const next = await api.selectNode(name);
      if (selectionGeneration !== nodeSelectionGenerationRef.current) return;
      commitSnapshot(next);
      const activeNode = next.nodes.find((node) => node.active)?.name || next.currentNode;
      const selected = activeNode === name || next.currentNode === name;
      setMessage(selected ? '已切换' : activeNode ? `已切至${activeNode}` : '切换失败');
    } catch (error) {
      if (selectionGeneration !== nodeSelectionGenerationRef.current) return;
      const next = await api.getSnapshot().catch(() => snapshotRef.current);
      commitSnapshot(next);
      setMessage(getActionErrorMessage(error));
    } finally {
      if (selectionGeneration === nodeSelectionGenerationRef.current) setSwitchingNode('');
    }
  }

  function changeUsageMode(next: UsageMode) {
    setUsageMode(next);
    setAdvancedUnlockClicks(0);
    if (next === 'easy') {
      setPage('home');
    }
  }

  function handleAdvancedUnlockClick() {
    const next = advancedUnlockClicks + 1;
    if (next >= 7) {
      changeUsageMode('advanced');
      return;
    }
    setAdvancedUnlockClicks(next);
  }

  function openRegistrationSwitch() {
    setMessage('');
    restoreRegistrationEntryFocusRef.current = true;
    setRegistrationSwitchOpen(true);
  }

  if (snapshotLoaded && (!registered || registrationSwitchOpen)) {
    const switchingUser = registered && registrationSwitchOpen;
    return (
      <RegistrationGate
        busy={busy}
        message={message}
        mode={switchingUser ? 'switch' : 'initial'}
        initialName={switchingUser ? snapshot.trafficIdentity?.name : undefined}
        onCancel={switchingUser ? () => setRegistrationSwitchOpen(false) : undefined}
        onRegister={async (input) => {
          const success = await runAction((api) => api.registerTrafficIdentity(input), '', {
            workingMessage: switchingUser ? '切换中' : '登记中',
            timeoutLabel: switchingUser ? '切换用户' : '登记'
          });
          if (success && switchingUser) setRegistrationSwitchOpen(false);
        }}
      />
    );
  }

  return (
    <>
      <AppShell
        page={page}
        usageMode={usageMode}
        onPageChange={setPage}
        onAdvancedUnlock={handleAdvancedUnlockClick}
        onRegistrationRequest={openRegistrationSwitch}
      >
        {page === 'home' && (
          <Home
            usageMode={usageMode}
            snapshot={snapshot}
            busy={busy}
            busyLabel={busyLabel}
            message={message}
            onQuickStart={quickStart}
            onStart={() =>
              runAction((api, request) => api.start(request), '已启动', {
                workingMessage: '启动中',
                timeoutLabel: '启动',
                cancellable: true
              })
            }
            onStop={() =>
              runAction((api) => api.stop(), '已停止', {
                workingMessage: '停止中',
                timeoutLabel: '停止'
              })
            }
            onRepair={() =>
              runAction((api, request) => api.repair(request), '已修复', {
                workingMessage: '修复中',
                timeoutLabel: '修复',
                cancellable: true
              })
            }
            onModeChange={(mode: MihomoMode) => runAction((api) => api.setMode(mode), '模式已切换')}
            onStrategyChange={(strategy) => runAction((api) => api.selectStrategy(strategy), '已切换')}
            onOpenNodes={() => setPage('nodes')}
            onUsageModeChange={changeUsageMode}
            onInstallUpdate={() => handleInstallUpdate()}
          />
        )}
        {page === 'nodes' && (
          <NodeSelect
            snapshot={snapshot}
            busy={busy}
            message={message}
            testingAll={testingAllNodes}
            switchingNode={switchingNode}
            onBack={() => setPage('home')}
            onSelect={selectNode}
            onTestNode={(name) => runAction((api) => api.testNode(name), '测速完成')}
            onTestAll={testAllNodes}
            onCancelTestAll={cancelNodeTests}
            onRefresh={() =>
              runAction((api, request) => api.updateSubscription(request), '已更新', {
                workingMessage: '更新中',
                timeoutLabel: '更新',
                cancellable: true
              })
            }
          />
        )}
        {page === 'test' && <TestPage snapshot={snapshot} />}
        {page === 'petPreview' && (
          <Suspense
            fallback={
              <div className="page-loading" role="status">
                加载中
              </div>
            }
          >
            <PetPreviewPage />
          </Suspense>
        )}
        {page === 'settings' && (
          <Settings
            snapshot={snapshot}
            busy={busy}
            busyLabel={busyLabel}
            message={settingsMessage}
            onBack={() => setPage('home')}
            onRepair={() =>
              runAction((api, request) => api.repair(request), '已修复', {
                workingMessage: '修复中',
                timeoutLabel: '修复',
                messageSink: setSettingsMessage,
                cancellable: true
              })
            }
            onSave={(settings: AppSettingsInput) =>
              runAction((api, request) => api.saveSettings(settings, request), '已保存', {
                workingMessage: '保存中',
                timeoutLabel: '保存',
                messageSink: setSettingsMessage,
                cancellable: true
              })
            }
            onSyncRemoteConfig={() =>
              runAction((api, request) => api.syncRemoteConfig(request), '已同步', {
                workingMessage: '同步中',
                timeoutLabel: '同步',
                messageSink: setSettingsMessage,
                cancellable: true
              })
            }
            onCheckUpdate={() =>
              runAction((api) => api.checkForUpdates(), '', {
                workingMessage: '检查中',
                timeoutLabel: '检查更新',
                messageSink: setSettingsMessage
              })
            }
            onInstallUpdate={() => handleInstallUpdate(setSettingsMessage)}
            onExportDiagnostics={() => void handleExportDiagnostics()}
          />
        )}
      </AppShell>
      {busyLabel === '修复中' && (
        <div className="busy-overlay" aria-live="polite" aria-label="修复中">
          <div className="busy-spinner" />
          <span>修复中</span>
        </div>
      )}
    </>
  );
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
  if (new URLSearchParams(window.location.search).get('mode') === 'advanced') return 'advanced';
  return 'easy';
}

function readInitialPage(): PageKey {
  const page = new URLSearchParams(window.location.search).get('page');
  if (page === 'nodes' || page === 'test' || page === 'petPreview' || page === 'settings') {
    return page;
  }
  return 'home';
}

export async function startEasyProxy(
  api: NonNullable<Window['youyu']>,
  requestTracker: OperationRequestTracker,
  signal?: AbortSignal
): Promise<AppSnapshot> {
  try {
    return await startAndSelectUsableNode(api, requestTracker, signal);
  } catch (error) {
    if (isInputError(error) || isOperationCancelled(error)) {
      throw error;
    }

    signal?.throwIfAborted();
    await api.repair(requestTracker.next()).catch((repairError) => {
      if (isOperationCancelled(repairError)) throw repairError;
      return undefined;
    });
    signal?.throwIfAborted();
    try {
      return await startAndSelectUsableNode(api, requestTracker, signal);
    } catch (retryError) {
      if (isOperationCancelled(retryError)) throw retryError;
      signal?.throwIfAborted();
      await api.repair(requestTracker.next()).catch((repairError) => {
        if (isOperationCancelled(repairError)) throw repairError;
        return undefined;
      });
      throw retryError;
    }
  }
}

async function startAndSelectUsableNode(
  api: NonNullable<Window['youyu']>,
  requestTracker: OperationRequestTracker,
  signal?: AbortSignal
): Promise<AppSnapshot> {
  signal?.throwIfAborted();
  const current = await api.getSnapshot();
  signal?.throwIfAborted();
  const started = current.status === 'running' ? current : await api.start(requestTracker.next());
  signal?.throwIfAborted();
  return ensureUsableNode(api, started, requestTracker, signal);
}

async function ensureUsableNode(
  api: NonNullable<Window['youyu']>,
  snapshot: AppSnapshot,
  requestTracker: OperationRequestTracker,
  signal?: AbortSignal
): Promise<AppSnapshot> {
  let next = snapshot;
  if (!next.nodes.length) {
    signal?.throwIfAborted();
    next = await api.updateSubscription(requestTracker.next()).catch((error) => {
      if (isOperationCancelled(error)) throw error;
      return next;
    });
    signal?.throwIfAborted();
  }

  signal?.throwIfAborted();
  next = await api.testAllNodes().catch((error) => {
    if (isOperationCancelled(error)) throw error;
    return next;
  });
  signal?.throwIfAborted();
  const activeMeasured = next.nodes.some((node) => node.active && isUsableDelay(node.delay));
  const bestNode = next.nodes
    .filter((node) => isUsableDelay(node.delay))
    .sort((left, right) => (left.delay ?? Number.MAX_SAFE_INTEGER) - (right.delay ?? Number.MAX_SAFE_INTEGER))[0];

  if (bestNode && !activeMeasured) {
    const selected = await api.selectBestAutoNode(requestTracker.next());
    signal?.throwIfAborted();
    return selected;
  }

  if (!bestNode) {
    throw new Error(next.nodes.length > 0 ? 'no usable proxy node' : 'no proxy nodes');
  }

  return next;
}

function isUsableDelay(delay: unknown): boolean {
  return typeof delay === 'number' && Number.isFinite(delay) && delay > 0;
}

function isInputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('missing subscription url') || message.includes('核心接口未加载');
}

function isOperationCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('operation canceled') ||
    message.includes('node testing cancelled') ||
    message.includes('AbortError')
  );
}

export function RegistrationGate({
  busy,
  message,
  mode = 'initial',
  initialName = '',
  onRegister,
  onCancel
}: {
  busy: boolean;
  message: string;
  mode?: 'initial' | 'switch';
  initialName?: string;
  onRegister: (input: TrafficRegistrationInput) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [passphrase, setPassphrase] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const canSubmit = Boolean(name.trim() && passphrase.trim());
  const switchingUser = mode === 'switch';
  const statusIsError = !busy && isActionErrorMessage(message);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    nameInputRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  function submit() {
    if (busy || !canSubmit) return;
    void onRegister({ name: name.trim(), passphrase: passphrase.trim() });
  }

  function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(dialogRef.current);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="registration-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="registration-title"
      aria-describedby="registration-description registration-status"
    >
      <section ref={dialogRef} className="registration-dialog" aria-busy={busy} onKeyDown={trapFocus}>
        <div>
          <h1 id="registration-title">{switchingUser ? '重新登记' : '使用登记'}</h1>
          <p id="registration-description">{switchingUser ? '输入姓名和口令以切换用户' : '填写姓名和口令后开始使用'}</p>
        </div>
        <form
          className="registration-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="field">
            <span>姓名</span>
            <input
              ref={nameInputRef}
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              readOnly={busy}
              aria-disabled={busy}
              required
            />
          </label>
          <label className="field">
            <span>口令</span>
            <input
              name="registration-passphrase"
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              readOnly={busy}
              aria-disabled={busy}
              required
            />
          </label>
          <div className={`registration-actions${switchingUser ? ' has-cancel' : ''}`}>
            {switchingUser && (
              <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
                取消
              </button>
            )}
            <button type="submit" className="wide-button" disabled={busy || !canSubmit}>
              {switchingUser ? '切换' : '登记'}
            </button>
          </div>
          <div
            id="registration-status"
            className={`registration-status${statusIsError ? ' is-error' : ''}`}
            aria-live="polite"
            aria-atomic="true"
          >
            {busy && <span className="registration-spinner" aria-hidden="true" />}
            <span>{busy ? (switchingUser ? '切换中' : '登记中') : message}</span>
          </div>
        </form>
      </section>
    </div>
  );
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation = '操作',
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch {
            // The timeout result must not depend on best-effort cancellation.
          }
          reject(new ActionTimeoutError(operation));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getActionErrorMessage(error: unknown): string {
  if (error instanceof ActionTimeoutError) return `${error.operation}超时`;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('operation timed out')) return '操作超时';
  if (message.includes('operation canceled')) return '已取消';
  if (message.includes('node testing cancelled') || message.includes('AbortError')) return '已停止';
  if (message.includes('missing subscription url')) return '先填写订阅地址';
  if (message.includes('no usable proxy node')) return '没有可用节点';
  if (message.includes('no proxy nodes')) return '没有可用节点';
  if (message.includes('核心接口未加载')) return '核心接口未加载';
  if (message.includes('traffic endpoint not configured')) return '先配置后台地址';
  if (message.includes('traffic identity required')) return '先完成登记';
  if (message.includes('missing traffic user name')) return '先填写姓名';
  if (message.includes('missing traffic passphrase')) return '先填写口令';
  if (message.includes('traffic activation failed: 403')) return '口令不对';
  if (message.includes('traffic activation failed: 429')) return '请求太频繁';
  if (message.includes('traffic activation failed: 5')) return '后台暂时不可用';
  if (message.includes('remote config failed: 401') || message.includes('traffic report failed: 401'))
    return '请重新登记';
  if (
    message.includes('signature required') ||
    message.includes('invalid signature') ||
    message.includes('stale signature')
  )
    return '请重新登记';
  if (message.includes('traffic request timed out')) return '连接后台超时';
  if (message.includes('fetch failed') || message.includes('Failed to fetch')) return '连接后台失败';
  if (message.includes('mihomo api failed')) return '更新失败';
  if (message.includes('mihomo controller')) return '启动失败';
  return '操作失败';
}

class ActionTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`operation timed out: ${operation}`);
    this.name = 'ActionTimeoutError';
  }
}

function createOperationRequest(): OperationRequest {
  return { requestId: globalThis.crypto?.randomUUID?.() ?? createFallbackRequestId() };
}

export function createOperationRequestTracker(): OperationRequestTracker {
  const tracker: OperationRequestTracker = {
    next: () => {
      const request = createOperationRequest();
      tracker.current = request;
      return request;
    }
  };
  return tracker;
}

function createFallbackRequestId(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}
