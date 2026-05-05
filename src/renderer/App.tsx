import { useEffect, useState } from 'react';
import type { AppSettingsInput, AppSnapshot, MihomoMode } from '../shared/ipc';
import { AppShell, type PageKey, type UsageMode } from './components/AppShell';
import { Home } from './pages/Home';
import { NodeSelect } from './pages/NodeSelect';
import { Settings } from './pages/Settings';
import { TestPage } from './pages/TestPage';

const emptySnapshot: AppSnapshot = {
  status: 'stopped',
  currentNode: '自动选择',
  nodes: [],
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
    dnsEnhanced: false,
    snifferEnabled: true,
    tunEnabled: true,
    strictRouteEnabled: true,
    allowLan: false
  },
  runtime: {
    activeConnections: 0,
    uploadTotal: 0,
    downloadTotal: 0
  },
  subscriptionUrl: '',
  diagnostics: {
    logs: []
  }
};

const easyStartSettings: AppSettingsInput = {
  mode: 'rule',
  strategy: 'auto',
  ruleProfile: 'subscription',
  systemProxyEnabled: true,
  dnsEnhanced: false,
  snifferEnabled: true,
  tunEnabled: true,
  strictRouteEnabled: true,
  allowLan: false
};
const actionTimeoutMs = 75000;

export function App() {
  const [page, setPage] = useState<PageKey>('home');
  const [usageMode, setUsageMode] = useState<UsageMode>(readUsageMode);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void runAction((api) => api.getSnapshot(), '');
  }, []);

  useEffect(() => {
    const dispose = window.youyu?.onSnapshotUpdated((next) => {
      setSnapshot(next);
      setBusy(false);
    });
    return dispose;
  }, []);

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

  async function runAction(action: (api: NonNullable<Window['youyu']>) => Promise<AppSnapshot>, doneMessage: string) {
    const api = window.youyu;
    if (!api) {
      setSnapshot((current) => ({ ...current, status: 'failed' }));
      setMessage('核心接口未加载');
      return;
    }

    setBusy(true);
    setMessage('');
    try {
      const next = await withTimeout(action(api), actionTimeoutMs);
      setSnapshot(next);
      setMessage(doneMessage);
    } catch (error) {
      const next = await api.getSnapshot().catch(() => snapshot);
      setSnapshot(next.status === 'running' ? next : { ...next, status: 'failed' });
      setMessage(getActionErrorMessage(error));
    } finally {
      setBusy(false);
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
    setMessage('');
    try {
      const next = await withTimeout(
        (async () => {
          const saved = await api.saveSettings({
            ...easyStartSettings,
            subscriptionUrl: nextUrl
          });
          return saved.status === 'running' ? saved : await api.start();
        })(),
        actionTimeoutMs
      );
      setSnapshot(next);
      setMessage('快速连接已启动');
    } catch (error) {
      const next = await api.getSnapshot().catch(() => snapshot);
      setSnapshot(next.status === 'running' ? next : { ...next, status: 'failed' });
      setMessage(getActionErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function changeUsageMode(next: UsageMode) {
    setUsageMode(next);
    if (next === 'easy') {
      setPage('home');
    }
  }

  return (
    <AppShell
      page={page}
      usageMode={usageMode}
      onPageChange={setPage}
    >
      {page === 'home' && (
        <Home
          usageMode={usageMode}
          snapshot={snapshot}
          busy={busy}
          message={message}
          onQuickStart={quickStart}
          onStart={() => runAction((api) => api.start(), '已启动')}
          onStop={() => runAction((api) => api.stop(), '已停止')}
          onRepair={() => runAction((api) => api.repair(), '已修复')}
          onModeChange={(mode: MihomoMode) => runAction((api) => api.setMode(mode), '模式已切换')}
          onUsageModeChange={changeUsageMode}
        />
      )}
      {page === 'nodes' && (
        <NodeSelect
          snapshot={snapshot}
          busy={busy}
          message={message}
          onBack={() => setPage('home')}
          onSelect={(name) => runAction((api) => api.selectNode(name), '已切换')}
          onTestNode={(name) => runAction((api) => api.testNode(name), '测速完成')}
          onTestAll={() => runAction((api) => api.testAllNodes(), '测速完成')}
          onRefresh={() => runAction((api) => api.updateSubscription(), '已更新')}
        />
      )}
      {page === 'test' && <TestPage snapshot={snapshot} />}
      {page === 'settings' && (
        <Settings
          snapshot={snapshot}
          busy={busy}
          message={message}
          onBack={() => setPage('home')}
          onRepair={() => runAction((api) => api.repair(), '已修复')}
          onSave={(settings: AppSettingsInput) => runAction((api) => api.saveSettings(settings), '已保存')}
        />
      )}
    </AppShell>
  );
}

function readUsageMode(): UsageMode {
  return 'easy';
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
  if (message.includes('missing subscription url')) return '先填写订阅地址';
  if (message.includes('核心接口未加载')) return '核心接口未加载';
  if (message.includes('mihomo api failed')) return '更新失败';
  if (message.includes('mihomo controller')) return '启动失败';
  return '操作失败';
}
