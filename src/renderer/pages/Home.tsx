import type { AppSnapshot, MihomoMode } from '../../shared/ipc';
import type { UsageMode } from '../components/AppShell';
import { BrandMark } from '../components/BrandMark';
import { PowerButton } from '../components/PowerButton';

type HomeProps = {
  usageMode: UsageMode;
  snapshot: AppSnapshot;
  busy: boolean;
  message: string;
  onQuickStart: (subscriptionUrl: string) => void;
  onStart: () => void;
  onStop: () => void;
  onRepair: () => void;
  onModeChange: (mode: MihomoMode) => void;
  onUsageModeChange: (mode: UsageMode) => void;
};

export function Home(props: HomeProps) {
  if (props.usageMode === 'easy') {
    return <EasyHome {...props} />;
  }

  return <AdvancedHome {...props} />;
}

function EasyHome(props: HomeProps) {
  const running = props.snapshot.status === 'running';
  const starting = props.busy && !running;
  const primaryLabel = props.busy ? '处理中' : running ? '停止使用' : '一键连接';

  function handlePrimaryAction() {
    if (running) {
      props.onStop();
      return;
    }

    props.onQuickStart(props.snapshot.subscriptionUrl);
  }

  return (
    <div className="workspace easy-workspace">
      <section className={`home-board easy-board ${running ? 'is-running' : ''}`}>
        <div className="launch-panel">
          <button
            className={`easy-power-button ${running ? 'running' : ''}`}
            disabled={props.busy}
            onClick={handlePrimaryAction}
            aria-label={primaryLabel}
          >
            <span className="startup-mark">
              <BrandMark size="lg" />
            </span>
            <span className={`startup-ring ${starting ? 'is-starting' : ''}`} aria-hidden="true" />
          </button>
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
          <h1>控制台</h1>
          <p>模式与运行状态</p>
        </div>
        <div className="header-actions">
          <button className="secondary-button mode-return-button" onClick={() => props.onUsageModeChange('easy')}>
            返回小白
          </button>
          <span className={`status-badge ${props.snapshot.status}`}>{statusLabel}</span>
        </div>
      </header>

      <section className={`home-board advanced-board ${running ? 'is-running' : ''} ${failed ? 'is-failed' : ''}`}>
        <div className="connection-card">
          <div className="connection-identity">
            <BrandMark size="md" />
            <div>
              <h2 title={props.snapshot.currentNode}>{props.snapshot.currentNode}</h2>
            </div>
          </div>
          <div className="connection-actions">
            <PowerButton
              status={props.snapshot.status}
              busy={props.busy}
              onStart={props.onStart}
              onStop={props.onStop}
            />
          </div>
        </div>

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

        <section className="panel runtime-panel">
          <h2>运行</h2>
          <div className="metric-row">
            <span className="label">模式</span>
            <strong>{formatMode(props.snapshot.mode)}</strong>
          </div>
          <div className="metric-row">
            <span className="label">连接</span>
            <strong>{props.snapshot.runtime.activeConnections}</strong>
          </div>
          <div className="metric-row">
            <span className="label">流量</span>
            <strong>{formatBytes(props.snapshot.runtime.uploadTotal + props.snapshot.runtime.downloadTotal)}</strong>
          </div>
        </section>

        <section className="panel diagnostics-panel">
          <h2>诊断</h2>
          {props.snapshot.diagnostics.lastError && (
            <p className="diagnostics-error">{props.snapshot.diagnostics.lastError}</p>
          )}
          <div className="diagnostics-log">
            {props.snapshot.diagnostics.logs.length ? (
              props.snapshot.diagnostics.logs.slice(-8).map((line) => <span key={line}>{line}</span>)
            ) : (
              <span>暂无日志</span>
            )}
          </div>
        </section>

      </section>
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

function formatMode(mode: MihomoMode): string {
  return modeOptions.find((option) => option.key === mode)?.label ?? mode;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
