import { useEffect, useRef, useState } from 'react';
import type { AppSettingsInput, AppSnapshot, MihomoMode, TrafficRegistrationInput } from '../shared/ipc';
import { AppShell, type PageKey, type UsageMode } from './components/AppShell';
import { Home } from './pages/Home';
import { NodeSelect } from './pages/NodeSelect';
import { PetPreviewPage } from './pages/PetPreviewPage';
import { Settings } from './pages/Settings';
import { TestPage } from './pages/TestPage';

const emptySnapshot: AppSnapshot = {
  status: 'stopped',
  currentNode: '自动选择',
  nodes: [],
  nodeHealth: {
    nodeName: '自动选择',
    delayStatus: 'untested',
    availability: {
      status: 'untested',
      totalCount: 10
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
  ruleProfile: 'subscription',
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
    reportStatus: 'idle'
  },
  subscriptionUrl: '',
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
  ruleProfile: 'subscription',
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

export function App() {
  const [page, setPage] = useState<PageKey>(readInitialPage);
  const [usageMode, setUsageMode] = useState<UsageMode>(readUsageMode);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [message, setMessage] = useState('');
  const [testingAllNodes, setTestingAllNodes] = useState(false);
  const testingAllNodesRef = useRef(false);
  const [switchingNode, setSwitchingNode] = useState('');
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [advancedUnlockClicks, setAdvancedUnlockClicks] = useState(0);
  const registered = Boolean(snapshot.trafficIdentity);

  useEffect(() => {
    void runAction((api) => api.getSnapshot(), '');
  }, []);

  useEffect(() => {
    const dispose = window.youyu?.onSnapshotUpdated((next) => {
      setSnapshot(next);
      setSnapshotLoaded(true);
      if (!testingAllNodesRef.current) {
        setBusy(false);
      }
    });
    return dispose;
  }, []);

  useEffect(() => {
    testingAllNodesRef.current = testingAllNodes;
  }, [testingAllNodes]);

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
    action: (api: NonNullable<Window['youyu']>) => Promise<AppSnapshot>,
    doneMessage: string,
    workingMessage = '',
    timeoutMs = actionTimeoutMs
  ) {
    const api = window.youyu;
    if (!api) {
      setSnapshot((current) => ({ ...current, status: 'failed' }));
      setMessage('核心接口未加载');
      return;
    }

    setBusy(true);
    setBusyLabel(workingMessage);
    setMessage('');
    try {
      const next = await withTimeout(action(api), timeoutMs);
      setSnapshot(next);
      setSnapshotLoaded(true);
      setMessage(doneMessage);
    } catch (error) {
      const next = await api.getSnapshot().catch(() => snapshot);
      setSnapshot(next.status === 'running' ? next : { ...next, status: 'failed' });
      setSnapshotLoaded(true);
      setMessage(getActionErrorMessage(error));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  }

  async function quickStart(subscriptionUrl: string) {
    const api = window.youyu;
    if (!api) {
      setSnapshot((current) => ({ ...current, status: 'failed' }));
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
    try {
      const next = await withTimeout(
        startEasyProxy(api, nextUrl, Boolean(snapshot.remoteSubscriptionUrl)),
        actionTimeoutMs
      );
      setSnapshot(next);
      setSnapshotLoaded(true);
      setMessage('已启动');
    } catch (error) {
      const next = await api.getSnapshot().catch(() => snapshot);
      setSnapshot(next.status === 'running' ? next : { ...next, status: 'failed' });
      setSnapshotLoaded(true);
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
      await runAction((api) => api.testAllNodes(), '测速完成', '测速中', nodeTestActionTimeoutMs);
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
      setSnapshot(next);
      setSnapshotLoaded(true);
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

    setSwitchingNode(name);
    setMessage('');
    try {
      const next = await withTimeout(api.selectNode(name), actionTimeoutMs);
      setSnapshot(next);
      setSnapshotLoaded(true);
      const activeNode = next.nodes.find((node) => node.active)?.name || next.currentNode;
      const selected = activeNode === name || next.currentNode === name;
      setMessage(selected ? '已切换' : activeNode ? `已切至${activeNode}` : '切换失败');
    } catch (error) {
      const next = await api.getSnapshot().catch(() => snapshot);
      setSnapshot(next.status === 'running' ? next : { ...next, status: 'failed' });
      setSnapshotLoaded(true);
      setMessage(getActionErrorMessage(error));
    } finally {
      setSwitchingNode('');
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

  return (
    <>
      <AppShell
        page={page}
        usageMode={usageMode}
        onPageChange={setPage}
        onAdvancedUnlock={handleAdvancedUnlockClick}
      >
        {page === 'home' && (
          <Home
            usageMode={usageMode}
            snapshot={snapshot}
            busy={busy}
            message={message}
            onQuickStart={quickStart}
            onStart={() => runAction((api) => api.start(), '已启动', '启动中')}
            onStop={() => runAction((api) => api.stop(), '已停止')}
            onRepair={() => runAction((api) => api.repair(), '已修复', '修复中')}
            onModeChange={(mode: MihomoMode) => runAction((api) => api.setMode(mode), '模式已切换')}
            onStrategyChange={(strategy) => runAction((api) => api.selectStrategy(strategy), '已切换')}
            onOpenNodes={() => setPage('nodes')}
            onUsageModeChange={changeUsageMode}
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
            onRefresh={() => runAction((api) => api.updateSubscription(), '已更新', '更新中')}
          />
        )}
        {page === 'test' && <TestPage snapshot={snapshot} />}
        {page === 'petPreview' && <PetPreviewPage />}
        {page === 'settings' && (
          <Settings
            snapshot={snapshot}
            busy={busy}
            message={message}
            onBack={() => setPage('home')}
            onRepair={() => runAction((api) => api.repair(), '已修复', '修复中')}
            onSave={(settings: AppSettingsInput) => runAction((api) => api.saveSettings(settings), '已保存')}
            onCheckUpdate={() => runAction((api) => api.checkForUpdates(), '', '检查中')}
            onInstallUpdate={() => runAction((api) => api.installUpdate(), '', '安装中')}
          />
        )}
      </AppShell>
      {snapshotLoaded && !registered && (
        <RegistrationGate
          busy={busy}
          message={message}
          onRegister={(input) => runAction((api) => api.registerTrafficIdentity(input), '已登记', '登记中')}
        />
      )}
      {busyLabel === '修复中' && (
        <div className="busy-overlay" aria-live="polite" aria-label="修复中">
          <div className="busy-spinner" />
          <span>修复中</span>
        </div>
      )}
    </>
  );
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

async function startEasyProxy(
  api: NonNullable<Window['youyu']>,
  subscriptionUrl: string,
  remoteManaged = false
): Promise<AppSnapshot> {
  try {
    return await startAndSelectUsableNode(api, subscriptionUrl, remoteManaged);
  } catch (error) {
    if (isInputError(error)) {
      throw error;
    }

    await api.repair().catch(() => undefined);
    try {
      return await startAndSelectUsableNode(api, subscriptionUrl, remoteManaged);
    } catch (retryError) {
      await api.repair().catch(() => undefined);
      throw retryError;
    }
  }
}

async function startAndSelectUsableNode(
  api: NonNullable<Window['youyu']>,
  subscriptionUrl: string,
  remoteManaged: boolean
): Promise<AppSnapshot> {
  const saved = await api.saveSettings({
    ...easyStartSettings,
    ...(remoteManaged ? {} : { subscriptionUrl })
  });
  const started = saved.status === 'running' ? saved : await api.start();
  return ensureUsableNode(api, started);
}

async function ensureUsableNode(
  api: NonNullable<Window['youyu']>,
  snapshot: AppSnapshot
): Promise<AppSnapshot> {
  let next = snapshot;
  if (!next.nodes.length) {
    next = await api.updateSubscription().catch(() => next);
  }

  next = await api.testAllNodes().catch(() => next);
  const activeMeasured = next.nodes.some((node) => node.active && isUsableDelay(node.delay));
  const bestNode = next.nodes
    .filter((node) => isUsableDelay(node.delay))
    .sort((left, right) => (left.delay ?? Number.MAX_SAFE_INTEGER) - (right.delay ?? Number.MAX_SAFE_INTEGER))[0];

  if (bestNode && !activeMeasured) {
    return api.selectBestAutoNode();
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

function RegistrationGate({
  busy,
  message,
  onRegister
}: {
  busy: boolean;
  message: string;
  onRegister: (input: TrafficRegistrationInput) => void;
}) {
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');

  function submit() {
    onRegister({ name, passphrase });
  }

  return (
    <div className="registration-gate" role="dialog" aria-modal="true" aria-labelledby="registration-title">
      <section className="registration-dialog">
        <div>
          <h1 id="registration-title">使用登记</h1>
          <p>填写姓名后开始使用</p>
        </div>
        <label className="field">
          <span>姓名</span>
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>口令</span>
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
        </label>
        <button className="wide-button" disabled={busy} onClick={submit}>
          登记
        </button>
        <div className="registration-status" aria-live="polite">
          {busy && <span className="registration-spinner" aria-hidden="true" />}
          <span>{busy ? '登记中' : message}</span>
        </div>
      </section>
    </div>
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('operation timed out')) return '启动超时';
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
  if (message.includes('traffic activation failed: 5')) return '后台暂时不可用';
  if (message.includes('traffic request timed out')) return '连接后台超时';
  if (message.includes('fetch failed') || message.includes('Failed to fetch')) return '连接后台失败';
  if (message.includes('mihomo api failed')) return '更新失败';
  if (message.includes('mihomo controller')) return '启动失败';
  return '操作失败';
}
