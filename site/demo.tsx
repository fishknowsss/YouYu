import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppSnapshot } from '../src/shared/ipc';
import { AppShell, type PageKey, type UsageMode } from '../src/renderer/components/AppShell';
import { WorkspaceHeader } from '../src/renderer/components/WorkspaceHeader';
import { Home } from '../src/renderer/pages/Home';
import { NodeSelect } from '../src/renderer/pages/NodeSelect';
import { TestPage } from '../src/renderer/pages/TestPage';
import { createDevYouYuApi } from '../src/renderer/devApi';
import '../src/renderer/styles.css';
import './demo.css';

const PetPanel = lazy(() => import('./pet-panel'));
const api = createDevYouYuApi({ preset: 'readme' });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function report(key: string, mode?: UsageMode) {
  window.parent.postMessage({ source: 'youyu-demo', type: 'feature', key, mode }, window.location.origin);
}
window.youyu = {
  ...api,
  async testConnectivity(key, request) {
    report('test');
    await delay(280);
    return api.testConnectivity(key, request);
  }
};

function Demo() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [mode, setMode] = useState<UsageMode>(
    new URLSearchParams(location.search).get('mode') === 'easy' ? 'easy' : 'advanced'
  );
  const [page, setPage] = useState<PageKey>('home');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const operation = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    void api.getSnapshot().then(setSnapshot);
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.origin !== window.location.origin ||
        event.data?.source !== 'youyu-site'
      )
        return;
      if (event.data.type === 'mode' && ['easy', 'advanced'].includes(event.data.mode)) {
        setMode(event.data.mode);
        setPage('home');
        report(event.data.mode, event.data.mode);
      }
    };
    window.addEventListener('message', receive);
    report('ready');
    return () => window.removeEventListener('message', receive);
  }, []);

  function changeMode(next: UsageMode) {
    setMode(next);
    setPage('home');
    report(next, next);
  }
  function navigate(next: PageKey) {
    setPage(next);
    setMessage('');
    report(next === 'home' ? mode : next, mode);
  }
  async function act(label: string, key: string, action: () => Promise<AppSnapshot>) {
    if (pending.current) return;
    pending.current = true;
    const token = ++operation.current;
    setBusy(label);
    setMessage('');
    report(key, mode);
    try {
      await delay(450);
      if (token !== operation.current) return;
      setSnapshot(await action());
    } catch {
      setMessage('演示未完成，请再试一次。');
    } finally {
      if (token === operation.current) {
        pending.current = false;
        setBusy('');
      }
    }
  }
  function cancelTests() {
    ++operation.current;
    pending.current = false;
    setBusy('');
    setMessage('已停止测速');
  }
  if (!snapshot)
    return (
      <p className="demo-loading" role="status">
        正在准备演示
      </p>
    );
  return (
    <div className="demo-root">
      <div className="demo-bar">
        <span>交互演示</span>
        <span>示例数据 · 不修改系统网络</span>
      </div>
      <AppShell page={page} usageMode={mode} onPageChange={navigate} onAdvancedUnlock={() => changeMode('advanced')}>
        {page === 'home' && (
          <Home
            usageMode={mode}
            snapshot={snapshot}
            busy={Boolean(busy)}
            busyLabel={busy}
            message={message}
            onQuickStart={() => void act('启动中', 'connect', api.start)}
            onStart={() => void act('启动中', 'connect', api.start)}
            onStop={() => void act('停止中', 'stop', api.stop)}
            onRepair={() => void act('修复中', 'repair', api.repair)}
            onModeChange={(next) => void act('切换中', next, () => api.setMode(next))}
            onStrategyChange={(next) => void act('切换中', 'auto', () => api.selectStrategy(next))}
            onOpenNodes={() => navigate('nodes')}
            onUsageModeChange={changeMode}
            onInstallUpdate={() => setMessage('演示使用当前版本，请从官网下载安装包。')}
          />
        )}
        {page === 'nodes' && (
          <NodeSelect
            snapshot={snapshot}
            busy={Boolean(busy)}
            message={message}
            testingAll={busy === '全部测速'}
            onSelect={(name) => void act('切换中', 'select', () => api.selectNode(name))}
            onTestNode={(name) => void act('测速中', 'speed', () => api.testNode(name))}
            onTestAll={() => void act('全部测速', 'speed', api.testAllNodes)}
            onCancelTestAll={cancelTests}
            onRefresh={() => void act('更新中', 'subscription', api.updateSubscription)}
          />
        )}
        {page === 'test' && <TestPage snapshot={snapshot} />}
        {page === 'settings' && (
          <div className="workspace demo-settings">
            <WorkspaceHeader title="网络设置" description="按使用需要调整" />
            <section className="panel demo-setting-panel">
              <label>
                <span>
                  <strong>TUN 模式</strong>
                  <span>接管部分不遵循系统代理的应用流量</span>
                </span>
                <input
                  type="checkbox"
                  checked={snapshot.features.tunEnabled}
                  disabled={Boolean(busy)}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    setSnapshot({ ...snapshot, features: { ...snapshot.features, tunEnabled: enabled } });
                    void act('切换中', 'tun', () => api.saveSettings({ tunEnabled: enabled }, 'advanced-save'));
                  }}
                />
              </label>
              <p>实际安装版还提供订阅管理、网络修复、诊断与更新。</p>
              <button
                className="wide-button"
                disabled={Boolean(busy)}
                onClick={() => void act('修复中', 'repair', api.repair)}
              >
                网络修复
              </button>
            </section>
          </div>
        )}
        {page === 'petPreview' && (
          <Suspense fallback={<p role="status">正在加载桌宠</p>}>
            <PetPanel onRelease={() => report('release-pet', mode)} />
          </Suspense>
        )}
      </AppShell>
      {mode === 'easy' && (
        <button className="demo-pet-release" onClick={() => report('release-pet', mode)}>
          放出桌宠
        </button>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Demo />);
