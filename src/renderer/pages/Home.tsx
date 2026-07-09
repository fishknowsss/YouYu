import type { AppSnapshot, MihomoMode, StrategyKey } from '../../shared/ipc';
import type { UsageMode } from '../components/AppShell';
import { BrandMark } from '../components/BrandMark';
import { PowerButton } from '../components/PowerButton';

type HomeProps = {
  usageMode: UsageMode;
  snapshot: AppSnapshot;
  busy: boolean;
  busyLabel: string;
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
  const failed = props.snapshot.status === 'failed';
  const starting = props.busyLabel === '启动中';
  const stopping = props.busyLabel === '停止中';
  const primaryLabel = props.busy ? props.busyLabel || '处理中' : running ? '停止使用' : '一键连接';
  const boardClassName = [
    'home-board',
    'easy-board',
    running ? 'is-running' : '',
    failed && !starting ? 'is-failed' : '',
    starting ? 'is-starting' : '',
    stopping ? 'is-stopping' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const powerButtonClassName = [
    'easy-power-button',
    running ? 'running' : failed && !starting ? 'failed' : 'idle',
    starting ? 'starting' : '',
    stopping ? 'stopping' : ''
  ]
    .filter(Boolean)
    .join(' ');

  function handlePrimaryAction() {
    if (running) {
      props.onStop();
      return;
    }

    props.onQuickStart(props.snapshot.subscriptionUrl);
  }

  return (
    <div className="workspace easy-workspace">
      <section className={boardClassName}>
        <div className="launch-panel">
          <button
            className={powerButtonClassName}
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
  const verifying = update.status === 'downloading' && typeof update.percent === 'number' && update.percent >= 99;
  const text = downloaded
    ? `已下载 ${version ?? '新版本'}`
    : downloading
      ? verifying
        ? '校验中'
        : version
        ? `下载中 ${version}`
        : '下载中'
      : version
        ? `发现 ${version}`
        : '发现更新';
  const progress = getDisplayUpdateProgress(update);
  const noticeClass = downloaded ? 'is-ready' : downloading ? 'is-downloading' : 'is-available';
  const stateLabel = verifying ? '校验中' : downloading ? '下载中' : '准备中';

  return (
    <aside className={`easy-update-notice ${noticeClass}`} aria-live="polite">
      <div className="easy-update-copy">
        <span>软件更新</span>
        <strong>{text}</strong>
      </div>
      {downloading && (
        <div className={`easy-update-progress ${verifying ? 'is-verifying' : ''}`} aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      {downloaded ? (
        <button className="wide-button" disabled={busy} onClick={onInstallUpdate}>
          安装
        </button>
      ) : (
        <span className="easy-update-state">{stateLabel}</span>
      )}
    </aside>
  );
}

function AdvancedHome(props: HomeProps) {
  const running = props.snapshot.status === 'running';
  const failed = props.snapshot.status === 'failed';
  const statusLabel = getStatusLabel(props.snapshot.status);
  const mostUsedNode = props.snapshot.traffic.nodeUsage.mostUsed;
  const longestUsedNode = props.snapshot.traffic.nodeUsage.longestUsed;
  const logLines = props.snapshot.diagnostics.logs.slice(-7);

  return (
    <div className="workspace advanced-workspace">
      <header className="workspace-header">
        <div>
          <h1>控制台</h1>
          <p>代理状态与节点</p>
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
          <div className="runtime-metric-grid">
            <RuntimeMetric label="今日上传" value={formatBytes(props.snapshot.traffic.todayUpload)} />
            <RuntimeMetric label="今日下载" value={formatBytes(props.snapshot.traffic.todayDownload)} />
            <RuntimeMetric label="累计上传" value={formatBytes(props.snapshot.traffic.totalUpload)} />
            <RuntimeMetric label="累计下载" value={formatBytes(props.snapshot.traffic.totalDownload)} />
            <RuntimeMetric
              label="常用节点"
              value={mostUsedNode?.name ?? '暂无'}
              detail={mostUsedNode ? formatBytes(mostUsedNode.upload + mostUsedNode.download) : undefined}
              variant="node"
            />
            <RuntimeMetric
              label="最长使用"
              value={longestUsedNode?.name ?? '暂无'}
              detail={longestUsedNode ? formatDuration(longestUsedNode.durationMs) : undefined}
              variant="node"
            />
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

function RuntimeMetric({
  label,
  value,
  detail,
  variant = 'metric'
}: {
  label: string;
  value: string;
  detail?: string;
  variant?: 'metric' | 'node';
}) {
  return (
    <div className={`runtime-metric${variant === 'node' ? ' runtime-metric-node' : ''}`}>
      <span className="label">{label}</span>
      <strong title={value}>{value}</strong>
      {detail && <small>{detail}</small>}
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}小时${minutes}分`;
  if (hours > 0) return `${hours}小时`;
  if (minutes > 0) return `${minutes}分钟`;
  return '不足1分钟';
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
  if (availability.tone === 'danger') return '不良';
  if (availability.tone === 'warning') return '一般';
  if (availability.tone === 'success') return '优秀';
  return '未测';
}

function getDisplayUpdateProgress(update: AppSnapshot['update']): number {
  if (typeof update.percent !== 'number') return 0;
  return Math.max(0, Math.min(100, Math.round(update.percent)));
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
