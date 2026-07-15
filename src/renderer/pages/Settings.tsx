import { useEffect, useRef, useState } from 'react';
import type { AppSettingsInput, AppSnapshot, RuleProfile } from '../../shared/ipc';
import { isActionErrorMessage } from '../actionMessages';

type SettingsProps = {
  snapshot: AppSnapshot;
  busy: boolean;
  busyLabel: string;
  message: string;
  onBack: () => void;
  onRepair: () => void;
  onSave: (settings: AppSettingsInput) => void;
  onSyncRemoteConfig: () => void;
  onExportDiagnostics: () => void;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
};

export function Settings({
  snapshot,
  busy,
  busyLabel,
  message,
  onBack,
  onRepair,
  onSave,
  onSyncRemoteConfig,
  onExportDiagnostics,
  onCheckUpdate,
  onInstallUpdate
}: SettingsProps) {
  const [subscriptionUrl, setSubscriptionUrl] = useState(snapshot.subscriptionUrl);
  const [ruleProfile, setRuleProfile] = useState<RuleProfile>(snapshot.ruleProfile);
  const [tunEnabled, setTunEnabled] = useState(snapshot.features.tunEnabled);
  const [subscriptionRefreshIntervalHours, setSubscriptionRefreshIntervalHours] = useState(
    snapshot.features.subscriptionRefreshIntervalHours
  );
  const [settingsDirty, setSettingsDirty] = useState(false);
  const pendingSettingsKey = useRef<string | undefined>(undefined);
  const remoteManaged = Boolean(snapshot.remoteSubscriptionUrl);
  const saving = busy && busyLabel === '保存中';
  const syncing = busy && busyLabel === '同步中';
  const repairing = busy && busyLabel === '修复中';
  const exporting = busy && busyLabel === '导出中';
  const diagnosticLogCount = snapshot.diagnostics.logCount ?? snapshot.diagnostics.logs.length;
  const diagnosticIssue = getDiagnosticIssueCopy(snapshot.diagnostics.issueKind);
  const actionMessageIsError = isActionErrorMessage(message);
  const actionStatus = actionMessageIsError ? message : diagnosticIssue || message;
  const actionStatusIsError = actionMessageIsError || Boolean(diagnosticIssue);

  useEffect(() => {
    const snapshotSettingsKey = getSnapshotSettingsKey(snapshot);
    if (settingsDirty && pendingSettingsKey.current !== snapshotSettingsKey) {
      return;
    }

    setSubscriptionUrl(snapshot.subscriptionUrl);
    setRuleProfile(snapshot.ruleProfile);
    setTunEnabled(snapshot.features.tunEnabled);
    setSubscriptionRefreshIntervalHours(snapshot.features.subscriptionRefreshIntervalHours);
    setSettingsDirty(false);
    pendingSettingsKey.current = undefined;
  }, [snapshot, settingsDirty]);

  function save() {
    const nextSettings: AppSettingsInput = {
      ruleProfile,
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled,
      strictRouteEnabled: true,
      subscriptionRefreshIntervalHours
    };
    if (!remoteManaged) {
      nextSettings.subscriptionUrl = subscriptionUrl.trim();
    }
    pendingSettingsKey.current = getInputSettingsKey({
      ...nextSettings,
      subscriptionUrl: subscriptionUrl.trim()
    });
    onSave(nextSettings);
  }

  return (
    <div className="workspace settings-workspace">
      <div className="workspace-header">
        <div>
          <h1>设置</h1>
          <p>订阅与网络开关</p>
        </div>
        <button className="secondary-button" onClick={onBack}>
          返回
        </button>
      </div>
      <section className="panel settings-panel">
        <div className="settings-form-grid">
          <label className="field settings-subscription-field">
            <span>订阅</span>
            <input
              value={subscriptionUrl}
              disabled={busy || remoteManaged}
              onChange={(event) => {
                setSettingsDirty(true);
                setSubscriptionUrl(event.target.value);
              }}
              placeholder="https://..."
            />
          </label>

          <div className="settings-controls-grid">
            <label className="field settings-control-field">
              <span>规则来源</span>
              <select
                value={ruleProfile}
                disabled={busy}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setRuleProfile(event.target.value as RuleProfile);
                }}
              >
                <option value="ruleset">智能规则</option>
                <option value="subscription">兼容机场</option>
                <option value="smart">本地规则</option>
                <option value="global">全局代理</option>
              </select>
            </label>
            <NetworkStatus label="系统代理" value={formatEnabled(snapshot.features.systemProxyEnabled)} />
            <button className="wide-button settings-save-button" disabled={busy} onClick={save}>
              {saving ? '保存中' : '保存'}
            </button>

            <label className="field settings-control-field">
              <span>后台刷新</span>
              <select
                value={subscriptionRefreshIntervalHours}
                disabled={busy}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setSubscriptionRefreshIntervalHours(Number(event.target.value));
                }}
              >
                <option value={0}>关闭</option>
                <option value={6}>6 小时</option>
                <option value={12}>12 小时</option>
                <option value={24}>24 小时</option>
              </select>
            </label>
            <NetworkStatus label="DNS 增强" value={formatEnabled(snapshot.features.dnsEnhanced)} />
            <button className="secondary-button settings-control-button" disabled={busy} onClick={onSyncRemoteConfig}>
              {syncing ? '同步中' : '同步'}
            </button>

            <label className="network-route-toggle settings-route-toggle">
              <span className="network-route-main">
                <input
                  type="checkbox"
                  checked={tunEnabled}
                  disabled={busy}
                  onChange={(event) => {
                    setSettingsDirty(true);
                    setTunEnabled(event.target.checked);
                  }}
                />
                <strong>TUN</strong>
              </span>
              <span className="network-route-note">严格路由 {tunEnabled ? '开启' : '待用'}</span>
            </label>
            <NetworkStatus label="流量识别" value={formatEnabled(snapshot.features.snifferEnabled)} />
            <button className="secondary-button settings-control-button" disabled={busy} onClick={onRepair}>
              {repairing ? '修复中' : '修复'}
            </button>
          </div>

          <div className="settings-footer">
            <div className="settings-diagnostics-bar">
              <div className="settings-diagnostics-summary" role="status" aria-live="polite" aria-atomic="true">
                {actionStatus && (
                  <span className={`settings-action-status${actionStatusIsError ? ' is-error' : ''}`}>
                    {actionStatus}
                  </span>
                )}
                <span className="settings-diagnostics-meta">
                  <span className="settings-diagnostics-label">诊断日志</span>
                  <strong className="settings-diagnostics-count">{diagnosticLogCount} 条</strong>
                </span>
              </div>
              <button
                className="secondary-button settings-footer-action settings-diagnostics-export"
                disabled={busy}
                onClick={onExportDiagnostics}
              >
                {exporting ? '导出中' : '导出'}
              </button>
            </div>

            <UpdatePanel
              snapshot={snapshot}
              busy={busy}
              onCheckUpdate={onCheckUpdate}
              onInstallUpdate={onInstallUpdate}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function formatEnabled(enabled: boolean): string {
  return enabled ? '开启' : '关闭';
}

function getDiagnosticIssueCopy(issueKind: AppSnapshot['diagnostics']['issueKind']): string {
  switch (issueKind) {
    case 'system-proxy':
      return '系统代理异常 · 点击修复';
    case 'dns':
      return 'DNS 异常 · 点击修复';
    case 'kernel':
      return '内核异常 · 点击修复';
    case 'network':
      return '网络连接异常 · 点击修复';
    case 'subscription':
      return '订阅异常 · 检查后保存';
    case 'permission':
      return '权限异常 · 管理员重启';
    case 'backend':
      return '后台异常 · 稍后同步';
    case 'registration':
      return '登记异常 · 重新登记';
    case 'unknown':
      return '运行异常 · 导出日志';
    default:
      return '';
  }
}

function NetworkStatus({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={`network-status-item${className ? ` ${className}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UpdatePanel({
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
  const ready = update.status === 'downloaded';
  const downloading = update.status === 'downloading';
  const verifying = update.downloadPhase === 'verifying';
  const fullPackage = update.downloadPhase === 'full-download';
  const waiting =
    update.status === 'checking' ||
    update.status === 'downloading' ||
    update.status === 'available' ||
    update.status === 'installing';
  const buttonLabel = ready
    ? '安装'
    : downloading
      ? verifying
        ? '校验中'
        : fullPackage
          ? '完整包'
          : '下载中'
      : update.status === 'checking'
        ? '检查中'
        : update.status === 'available'
          ? '准备中'
          : update.status === 'installing'
            ? '安装中'
            : '检查';
  const progress = getDisplayUpdateProgress(update);

  const statusText = formatUpdateStatus(update);

  return (
    <div
      className={`update-row ${waiting ? 'is-busy' : ''} ${downloading ? 'is-downloading' : ''} ${
        update.status === 'failed' ? 'is-failed' : ''
      }`}
      aria-busy={waiting}
    >
      <div className="update-copy" role="status" aria-live="polite" aria-atomic="true">
        <span>软件更新</span>
        <strong title={statusText}>{statusText}</strong>
        {downloading && <em>{formatUpdateTransfer(update)}</em>}
      </div>
      {downloading && (
        <div className={`update-progress ${verifying ? 'is-verifying' : ''}`} aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      <button
        className={`${ready ? 'wide-button' : 'secondary-button'} settings-footer-action`}
        disabled={busy || waiting}
        onClick={ready ? onInstallUpdate : onCheckUpdate}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function formatUpdateStatus(update: AppSnapshot['update']): string {
  if (update.status === 'checking') return '检查中';
  if (update.status === 'available') return update.availableVersion ? `发现 ${update.availableVersion}` : '发现更新';
  if (update.status === 'downloading') {
    const version = update.availableVersion ? ` ${update.availableVersion}` : '';
    if (update.downloadPhase === 'verifying') return `正在校验更新包${version}`;
    const label = update.downloadPhase === 'full-download' ? '正在下载完整更新包' : '正在下载更新包';
    return typeof update.percent === 'number'
      ? `${label}${version} ${Math.max(0, Math.min(100, Math.round(update.percent)))}%`
      : `${label}${version}`;
  }
  if (update.status === 'downloaded') {
    return update.downloadedVersion ? `已下载 ${update.downloadedVersion}` : '已下载';
  }
  if (update.status === 'not-available') return update.message || '已是最新';
  if (update.status === 'failed') return formatUpdateFailure(update.message);
  if (update.status === 'installing') return '正在启动安装器';
  return '待检查';
}

function formatUpdateTransfer(update: AppSnapshot['update']): string {
  if (update.downloadPhase === 'verifying') return '下载完成，正在检查文件完整性';
  if (typeof update.transferredBytes !== 'number' || typeof update.totalBytes !== 'number' || update.totalBytes <= 0) {
    return typeof update.percent === 'number' ? `${Math.round(update.percent)}%` : '准备下载';
  }
  const speed =
    typeof update.bytesPerSecond === 'number' && update.bytesPerSecond > 0
      ? ` · ${formatBytes(update.bytesPerSecond)}/s`
      : '';
  return `${formatBytes(update.transferredBytes)} / ${formatBytes(update.totalBytes)}${speed}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUpdateFailure(message: string | undefined): string {
  if (!message) return '失败：原因未知';
  const channelFile = message.match(/(latest(?:-in|-no)?\.yml)/)?.[1];
  if (message.includes('Cannot find') && channelFile) return `失败：GitHub Release 缺少 ${channelFile}`;
  if (message.includes('404')) return '失败：GitHub Release 未发布或资源不存在';
  if (
    message.includes('ENOTFOUND') ||
    message.includes('EAI_AGAIN') ||
    message.includes('ERR_NAME_NOT_RESOLVED') ||
    message.includes('fetch failed')
  ) {
    return '失败：无法连接 GitHub';
  }
  if (message.includes('net::ERR_INTERNET_DISCONNECTED')) return '失败：网络未连接';
  return '失败：请稍后重试';
}

function getDisplayUpdateProgress(update: AppSnapshot['update']): number {
  if (typeof update.percent !== 'number') return 0;
  return Math.max(0, Math.min(100, Math.round(update.percent)));
}

function getSnapshotSettingsKey(snapshot: AppSnapshot): string {
  return getInputSettingsKey({
    subscriptionUrl: snapshot.subscriptionUrl,
    ruleProfile: snapshot.ruleProfile,
    systemProxyEnabled: true,
    dnsEnhanced: true,
    snifferEnabled: true,
    tunEnabled: snapshot.features.tunEnabled,
    strictRouteEnabled: true,
    subscriptionRefreshIntervalHours: snapshot.features.subscriptionRefreshIntervalHours
  });
}

function getInputSettingsKey(settings: AppSettingsInput): string {
  return JSON.stringify({
    subscriptionUrl: settings.subscriptionUrl ?? '',
    ruleProfile: settings.ruleProfile ?? 'ruleset',
    systemProxyEnabled: settings.systemProxyEnabled ?? true,
    dnsEnhanced: settings.dnsEnhanced ?? true,
    snifferEnabled: true,
    tunEnabled: settings.tunEnabled ?? false,
    strictRouteEnabled: settings.strictRouteEnabled ?? true,
    subscriptionRefreshIntervalHours: settings.subscriptionRefreshIntervalHours ?? 12
  });
}
