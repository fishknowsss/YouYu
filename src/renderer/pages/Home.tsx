import type { AppSnapshot, MihomoMode, StrategyKey } from '../../shared/ipc';
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
  onStrategyChange: (strategy: StrategyKey) => void;
  onOpenNodes: () => void;
  onUsageModeChange: (mode: UsageMode) => void;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
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
  const stopping = props.busy && running;
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
      <section
        className={`home-board easy-board ${running ? 'is-running' : ''} ${starting ? 'is-starting' : ''} ${
          stopping ? 'is-stopping' : ''
        }`}
      >
        <div className="launch-panel">
          <button
            className={`easy-power-button ${running ? 'running' : 'idle'} ${starting ? 'starting' : ''} ${
              stopping ? 'stopping' : ''
            }`}
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
        <EasyUpdateNotice
          snapshot={props.snapshot}
          busy={props.busy}
          onCheckUpdate={props.onCheckUpdate}
          onInstallUpdate={props.onInstallUpdate}
        />
      </section>
    </div>
  );
}

function EasyUpdateNotice({
  snapshot,
  busy,
  onCheckUpdate,
  onInstallUpdate
}: {
  snapshot: AppSnapshot;
  busy: boolean;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  const update = snapshot.update;
  const visible = update.status === 'available' || update.status === 'downloading' || update.status === 'downloaded';
  if (!visible) return null;

  const downloaded = update.status === 'downloaded';
  const downloading = update.status === 'downloading';
  const version = update.downloadedVersion || update.availableVersion;
  const text = downloaded ? `已下载 ${version ?? '新版本'}` : downloading ? '正在下载更新' : `发现 ${version ?? '新版本'}`;
  const progress = typeof update.percent === 'number' ? update.percent : 0;

  return (
    <aside className={`easy-update-notice ${downloaded ? 'is-ready' : ''}`} aria-live="polite">
      <div className="easy-update-copy">
        <span>软件更新</span>
        <strong>{text}</strong>
      </div>
      {downloading && (
        <div className="easy-update-progress" aria-hidden="true">
          <span style={{ width: `${Math.max(8, progress)}%` }} />
        </div>
      )}
      <button
        className={downloaded ? 'wide-button' : 'secondary-button'}
        disabled={busy || downloading}
        onClick={downloaded ? onInstallUpdate : onCheckUpdate}
      >
        {downloaded ? '安装' : downloading ? '下载中' : '更新'}
      </button>
    </aside>
  );
}

function AdvancedHome(props: HomeProps) {
  const running = props.snapshot.status === 'running';
  const failed = props.snapshot.status === 'failed';
  const statusLabel = getStatusLabel(props.snapshot.status);
  const totalTraffic = formatBytes(props.snapshot.runtime.uploadTotal + props.snapshot.runtime.downloadTotal);
  const persistedTraffic = formatBytes(props.snapshot.traffic.totalUpload + props.snapshot.traffic.totalDownload);
  const logLines = props.snapshot.diagnostics.logs.slice(-7);

  return (
    <div className="workspace advanced-workspace">
      <header className="workspace-header">
        <div>
          <h1>控制台</h1>
          <p>代理状态与模式</p>
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
            <div>
              <span>当前节点</span>
              <h2 title={props.snapshot.currentNode}>{props.snapshot.currentNode}</h2>
            </div>
          </div>
          <div className="connection-actions">
            <NodeHealth snapshot={props.snapshot} />
            <div className="node-mode-toggle" aria-label="节点方式">
              <button
                className={props.snapshot.strategy === 'manual' ? 'active' : ''}
                disabled={props.busy}
                onClick={props.onOpenNodes}
              >
                手动
              </button>
              <button
                className={props.snapshot.strategy !== 'manual' ? 'active' : ''}
                disabled={props.busy}
                onClick={() => props.onStrategyChange('auto')}
              >
                自动
              </button>
            </div>
            <PowerButton
              status={props.snapshot.status}
              busy={props.busy}
              onStart={props.onStart}
              onStop={props.onStop}
            />
          </div>
        </div>

        <section className="panel mode-panel">
          <h2>代理模式</h2>
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
          <h2>运行数据</h2>
          <div className="metric-grid">
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
              <strong>{totalTraffic}</strong>
            </div>
            <div className="metric-row">
              <span className="label">累计</span>
              <strong>{persistedTraffic}</strong>
            </div>
          </div>
        </section>

        <section className="panel diagnostics-panel">
          <div className="panel-title-row">
            <h2>诊断</h2>
            <span>{props.snapshot.diagnostics.logs.length} 条</span>
          </div>
          {props.snapshot.diagnostics.lastError && (
            <p className="diagnostics-error">{props.snapshot.diagnostics.lastError}</p>
          )}
          <div className="diagnostics-log">
            {logLines.length ? (
              logLines.map((line, index) => <span key={`${index}-${line}`}>{line}</span>)
            ) : (
              <span>暂无日志</span>
            )}
          </div>
        </section>

      </section>
    </div>
  );
}

function NodeHealth({ snapshot }: { snapshot: AppSnapshot }) {
  const health = snapshot.nodeHealth;
  if (snapshot.status !== 'running') {
    return (
      <div className="connection-health connection-health-single" aria-label="节点状态 未连接">
        <div className="node-health-metric node-health-summary is-muted">
          <strong>未连接</strong>
        </div>
      </div>
    );
  }

  if (health.delayStatus === 'untested' && health.availability.status === 'untested') {
    return (
      <div className="connection-health connection-health-single" aria-label="节点状态 检测中">
        <div className="node-health-metric node-health-summary is-testing">
          <strong>检测中</strong>
        </div>
      </div>
    );
  }

  return (
    <div className="connection-health" aria-label="节点状态">
      <div
        className={`node-health-metric ${getDelayToneClass(health.delay, health.delayStatus)}`}
        aria-label={`延迟 ${formatDelay(health)}`}
      >
        <strong>{formatDelay(health)}</strong>
      </div>
      <div
        className={`node-health-metric ${getAvailabilityToneClass(health.availability)}`}
        aria-label={`可用度 ${formatAvailability(health.availability)}`}
      >
        <strong>{formatAvailability(health.availability)}</strong>
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

function formatMode(mode: MihomoMode): string {
  return modeOptions.find((option) => option.key === mode)?.label ?? mode;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function formatDelay(health: AppSnapshot['nodeHealth']): string {
  if (health.delayStatus === 'testing') return '测试中';
  if (health.delayStatus === 'failed') return '失败';
  if (typeof health.delay === 'number') return `${health.delay} ms`;
  return '未测';
}

function formatAvailability(availability: AppSnapshot['nodeHealth']['availability']): string {
  if (availability.status === 'testing') return '测试中';
  if (availability.status === 'failed') return '失败';
  if (typeof availability.availableCount === 'number') {
    if (availability.availableCount <= 5) return '不良';
    if (availability.availableCount <= 8) return '一般';
    return '优秀';
  }
  return '未测';
}

function getDelayToneClass(delay: number | undefined, status: AppSnapshot['nodeHealth']['delayStatus']): string {
  if (status === 'testing') return 'is-testing';
  if (status === 'failed') return 'is-danger';
  if (typeof delay !== 'number') return 'is-muted';
  if (delay <= 120) return 'is-success';
  if (delay <= 260) return 'is-warning';
  return 'is-danger';
}

function getAvailabilityToneClass(availability: AppSnapshot['nodeHealth']['availability']): string {
  if (availability.status === 'testing') return 'is-testing';
  if (availability.status === 'failed') return 'is-danger';
  if (availability.tone === 'success') return 'is-success';
  if (availability.tone === 'warning') return 'is-warning';
  if (availability.tone === 'danger') return 'is-danger';
  return 'is-muted';
}
