import { useEffect, useState } from 'react';
import type { AppSnapshot, MihomoMode, StrategyKey } from '../../shared/ipc';
import type { UsageMode } from '../components/AppShell';
import { BrandMark } from '../components/BrandMark';
import { PowerButton } from '../components/PowerButton';

type HomeProps = {
  usageMode: UsageMode;
  snapshot: AppSnapshot;
  busy: boolean;
  message: string;
  onUsageModeChange: (mode: UsageMode) => void;
  onQuickStart: (subscriptionUrl: string) => void;
  onStart: () => void;
  onStop: () => void;
  onRepair: () => void;
  onModeChange: (mode: MihomoMode) => void;
  onStrategyChange: (strategy: StrategyKey) => void;
  onCloseConnections: () => void;
  onNodeSelect: () => void;
  onSettings: () => void;
};

export function Home(props: HomeProps) {
  const [quickSubscriptionUrl, setQuickSubscriptionUrl] = useState(props.snapshot.subscriptionUrl);
  const [showQuickSubscription, setShowQuickSubscription] = useState(false);

  useEffect(() => {
    setQuickSubscriptionUrl(props.snapshot.subscriptionUrl);
  }, [props.snapshot.subscriptionUrl]);

  if (props.usageMode === 'easy') {
    return (
      <EasyHome
        {...props}
        quickSubscriptionUrl={quickSubscriptionUrl}
        showQuickSubscription={showQuickSubscription}
        onQuickSubscriptionUrlChange={setQuickSubscriptionUrl}
        onShowQuickSubscriptionChange={setShowQuickSubscription}
      />
    );
  }

  return <AdvancedHome {...props} />;
}

function EasyHome(
  props: HomeProps & {
    quickSubscriptionUrl: string;
    showQuickSubscription: boolean;
    onQuickSubscriptionUrlChange: (value: string) => void;
    onShowQuickSubscriptionChange: (value: boolean) => void;
  }
) {
  const running = props.snapshot.status === 'running';
  const failed = props.snapshot.status === 'failed';
  const statusLabel = getStatusLabel(props.snapshot.status);
  const primaryLabel = props.busy ? '处理中' : running ? '停止使用' : '一键连接';
  const subscriptionValue = props.quickSubscriptionUrl;
  const helperText = running
    ? `已连接：${props.snapshot.currentNode}`
    : failed
      ? '连接失败，可重新尝试'
      : props.snapshot.subscriptionUrl
        ? '订阅已保存，可以直接连接'
        : '粘贴订阅地址后点击连接';
  const currentDelay = getCurrentDelay(props.snapshot);
  const showEditor = props.showQuickSubscription;

  function handlePrimaryAction() {
    if (running) {
      props.onStop();
      return;
    }

    if (!subscriptionValue.trim() && !props.snapshot.subscriptionUrl.trim()) {
      props.onShowQuickSubscriptionChange(true);
      return;
    }

    props.onQuickStart(subscriptionValue);
  }

  return (
    <div className="workspace easy-workspace">
      <header className="workspace-header">
        <div>
          <span className="section-label">YouYu 快速</span>
          <h1>一键上网</h1>
        </div>
        <span className={`status-badge ${props.snapshot.status}`}>{statusLabel}</span>
      </header>

      <section className={`easy-hero ${running ? 'is-running' : ''} ${failed ? 'is-failed' : ''}`}>
        <div className="easy-main">
          <div className="easy-title-row">
            <div>
              <h2>{running ? '正在使用' : failed ? '连接遇到问题' : '准备连接'}</h2>
              <p>{helperText}</p>
            </div>
          </div>

          <button
            className={`easy-power-button ${running ? 'running' : ''}`}
            disabled={props.busy}
            onClick={handlePrimaryAction}
            aria-label={primaryLabel}
          >
            <BrandMark size="md" />
            <span>{primaryLabel}</span>
          </button>

          <div className="quick-status-card" aria-label="快速连接状态">
            <div>
              <span>当前节点</span>
              <strong>{props.snapshot.currentNode}</strong>
            </div>
            <div>
              <span>延迟</span>
              <strong>{currentDelay}</strong>
            </div>
          </div>

          {showEditor ? (
            <label className="quick-field">
              <span>订阅地址</span>
              <input
                value={subscriptionValue}
                onChange={(event) => props.onQuickSubscriptionUrlChange(event.target.value)}
                placeholder="https://..."
              />
            </label>
          ) : (
            <button
              className="quick-edit-button"
              disabled={props.busy}
              onClick={() => props.onShowQuickSubscriptionChange(true)}
            >
              编辑订阅
            </button>
          )}

          {props.message ? <p className="inline-message">{props.message}</p> : null}
        </div>
      </section>
    </div>
  );
}

function AdvancedHome(props: HomeProps) {
  const running = props.snapshot.status === 'running';
  const failed = props.snapshot.status === 'failed';
  const statusLabel = getStatusLabel(props.snapshot.status);

  return (
    <div className="workspace advanced-workspace">
      <header className="workspace-header">
        <div>
          <span className="section-label">YouYu 专业</span>
          <h1>专业代理控制台</h1>
          <p>节点、策略、模式和运行状态集中管理</p>
        </div>
        <span className={`status-badge ${props.snapshot.status}`}>{statusLabel}</span>
      </header>

      <section className={`connection-card ${running ? 'is-running' : ''} ${failed ? 'is-failed' : ''}`}>
        <div className="connection-identity">
          <BrandMark size="md" />
          <div>
            <span className="label">当前节点</span>
            <h2>{props.snapshot.currentNode}</h2>
            <p>{props.snapshot.subscriptionUrl ? '订阅已保存' : '先在设置中保存订阅地址'}</p>
          </div>
        </div>
        <div className="connection-actions">
          <PowerButton
            status={props.snapshot.status}
            busy={props.busy}
            onStart={props.onStart}
            onStop={props.onStop}
          />
          <button className="secondary-button" disabled={props.busy} onClick={props.onCloseConnections}>
            清理连接
          </button>
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="panel mode-panel">
          <h2>模式</h2>
          <div className="mode-strip" aria-label="代理模式">
            {modeOptions.map((mode) => (
              <button
                key={mode.key}
                className={props.snapshot.mode === mode.key ? 'active' : ''}
                disabled={props.busy}
                onClick={() => props.onModeChange(mode.key)}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </section>

        <section className="panel strategy-panel">
          <h2>策略</h2>
          <div className="strategy-grid">
            {props.snapshot.strategies.map((strategy) => (
              <button
                key={strategy.key}
                className={strategy.active ? 'active' : ''}
                disabled={props.busy}
                onClick={() => props.onStrategyChange(strategy.key)}
              >
                <span>{strategy.label}</span>
                <strong>{formatDelay(strategy.delay)}</strong>
              </button>
            ))}
          </div>
        </section>

        <section className="panel runtime-panel">
          <h2>运行</h2>
          <div className="metric-row">
            <span className="label">连接</span>
            <strong>{props.snapshot.runtime.activeConnections}</strong>
          </div>
          <div className="metric-row">
            <span className="label">流量</span>
            <strong>{formatBytes(props.snapshot.runtime.uploadTotal + props.snapshot.runtime.downloadTotal)}</strong>
          </div>
          {props.message ? <p className="inline-message">{props.message}</p> : null}
        </section>

        <section className="panel quick-panel">
          <h2>快捷操作</h2>
          <div className="action-row">
            <button onClick={props.onNodeSelect}>节点</button>
            <button onClick={props.onSettings}>设置</button>
          </div>
        </section>
        <section className="panel subscription-panel">
          <h2>订阅</h2>
          <p>{props.snapshot.subscriptionUrl ? '已保存订阅' : '先添加订阅'}</p>
        </section>
      </div>
    </div>
  );
}

function getStatusLabel(status: AppSnapshot['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'failed') return '启动失败';
  return '已停止';
}

const modeOptions: Array<{ key: MihomoMode; label: string }> = [
  { key: 'rule', label: '规则' },
  { key: 'global', label: '全局' },
  { key: 'direct', label: '直连' }
];

function formatDelay(delay: number | undefined): string {
  return typeof delay === 'number' ? `${delay}ms` : '--';
}

function getCurrentDelay(snapshot: AppSnapshot): string {
  const activeNode = snapshot.nodes.find((node) => node.active);
  if (activeNode?.delay !== undefined) return formatDelay(activeNode.delay);

  const activeStrategy = snapshot.strategies.find((strategy) => strategy.active);
  if (activeStrategy?.delay !== undefined) return formatDelay(activeStrategy.delay);

  return '--';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
