import { useEffect, useRef, useState } from 'react';
import type { AppSettingsInput, AppSnapshot, RuleProfile } from '../../shared/ipc';

type SettingsProps = {
  snapshot: AppSnapshot;
  busy: boolean;
  message: string;
  onBack: () => void;
  onRepair: () => void;
  onSave: (settings: AppSettingsInput) => void;
  onSyncRemoteConfig: () => void;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
};

export function Settings({
  snapshot,
  busy,
  message,
  onBack,
  onRepair,
  onSave,
  onSyncRemoteConfig,
  onCheckUpdate,
  onInstallUpdate
}: SettingsProps) {
  const [subscriptionUrl, setSubscriptionUrl] = useState(snapshot.subscriptionUrl);
  const [ruleProfile, setRuleProfile] = useState<RuleProfile>(snapshot.ruleProfile);
  const [systemProxyEnabled, setSystemProxyEnabled] = useState(snapshot.features.systemProxyEnabled);
  const [dnsEnhanced, setDnsEnhanced] = useState(snapshot.features.dnsEnhanced);
  const [tunEnabled, setTunEnabled] = useState(snapshot.features.tunEnabled);
  const [strictRouteEnabled, setStrictRouteEnabled] = useState(snapshot.features.strictRouteEnabled);
  const [subscriptionRefreshIntervalHours, setSubscriptionRefreshIntervalHours] = useState(
    snapshot.features.subscriptionRefreshIntervalHours
  );
  const [settingsDirty, setSettingsDirty] = useState(false);
  const pendingSettingsKey = useRef<string | undefined>(undefined);
  const remoteManaged = Boolean(snapshot.remoteSubscriptionUrl);

  useEffect(() => {
    const snapshotSettingsKey = getSnapshotSettingsKey(snapshot);
    if (settingsDirty && pendingSettingsKey.current !== snapshotSettingsKey) {
      return;
    }

    setSubscriptionUrl(snapshot.subscriptionUrl);
    setRuleProfile(snapshot.ruleProfile);
    setSystemProxyEnabled(snapshot.features.systemProxyEnabled);
    setDnsEnhanced(snapshot.features.dnsEnhanced);
    setTunEnabled(snapshot.features.tunEnabled);
    setStrictRouteEnabled(snapshot.features.strictRouteEnabled);
    setSubscriptionRefreshIntervalHours(snapshot.features.subscriptionRefreshIntervalHours);
    setSettingsDirty(false);
    pendingSettingsKey.current = undefined;
  }, [snapshot, settingsDirty]);

  function save() {
    const nextSettings: AppSettingsInput = {
      ruleProfile,
      systemProxyEnabled,
      dnsEnhanced,
      snifferEnabled: true,
      tunEnabled,
      strictRouteEnabled,
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
        <div className="settings-main">
          <div className="settings-config-grid">
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
            <div className="form-grid">
              <label className="field">
                <span>规则来源</span>
                <select
                  value={ruleProfile}
                  disabled={busy}
                  onChange={(event) => {
                    setSettingsDirty(true);
                    setRuleProfile(event.target.value as RuleProfile);
                  }}
                >
                  <option value="smart">智能分流</option>
                  <option value="global">全部代理</option>
                  <option value="subscription">机场配置</option>
                </select>
              </label>
              <label className="field">
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
            </div>
            <div className="settings-actions">
              <button className="wide-button" disabled={busy} onClick={save}>
                保存
              </button>
              <button className="secondary-button" disabled={busy} onClick={onSyncRemoteConfig}>
                同步
              </button>
              <button className="secondary-button" disabled={busy} onClick={onRepair}>
                修复
              </button>
            </div>
          </div>
          <div className="toggle-grid">
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={systemProxyEnabled}
                disabled={busy}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setSystemProxyEnabled(event.target.checked);
                }}
              />
              <span>系统代理</span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={dnsEnhanced}
                disabled={busy}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setDnsEnhanced(event.target.checked);
                }}
              />
              <span>DNS 增强</span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={tunEnabled}
                disabled={busy}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setTunEnabled(event.target.checked);
                }}
              />
              <span>TUN</span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={strictRouteEnabled}
                disabled={busy}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setStrictRouteEnabled(event.target.checked);
                }}
              />
              <span>严格路由</span>
            </label>
          </div>
        </div>
        <p className="inline-message">{message || ' '}</p>
        <UpdatePanel snapshot={snapshot} busy={busy} onCheckUpdate={onCheckUpdate} onInstallUpdate={onInstallUpdate} />
      </section>
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
  const waiting = update.status === 'checking' || update.status === 'downloading' || update.status === 'available';
  const buttonLabel = ready
    ? '安装'
    : downloading
      ? '下载中'
      : update.status === 'checking'
        ? '检查中'
        : update.status === 'available'
          ? '准备中'
          : '检查';
  const progress = typeof update.percent === 'number' ? update.percent : 0;

  const statusText = formatUpdateStatus(update);

  return (
    <div
      className={`update-row ${waiting ? 'is-busy' : ''} ${downloading ? 'is-downloading' : ''} ${
        update.status === 'failed' ? 'is-failed' : ''
      }`}
    >
      <div className="update-copy">
        <span>软件更新</span>
        <strong title={statusText}>{statusText}</strong>
      </div>
      {downloading && (
        <div className="update-progress" aria-hidden="true">
          <span style={{ width: `${Math.max(8, progress)}%` }} />
        </div>
      )}
      <button
        className={ready ? 'wide-button' : 'secondary-button'}
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
    return typeof update.percent === 'number' ? `下载 ${update.percent}%` : '下载中';
  }
  if (update.status === 'downloaded') {
    return update.downloadedVersion ? `已下载 ${update.downloadedVersion}` : '已下载';
  }
  if (update.status === 'not-available') return update.message || '已是最新';
  if (update.status === 'failed') return formatUpdateFailure(update.message);
  return '待检查';
}

function formatUpdateFailure(message: string | undefined): string {
  if (!message) return '失败：原因未知';
  const channelFile = message.match(/(latest(?:-in|-no)?\.yml)/)?.[1];
  if (message.includes('Cannot find') && channelFile) return `失败：GitHub Release 缺少 ${channelFile}`;
  if (message.includes('404')) return '失败：GitHub Release 未发布或资源不存在';
  if (message.includes('ENOTFOUND') || message.includes('EAI_AGAIN')) return '失败：无法连接 GitHub';
  if (message.includes('net::ERR_INTERNET_DISCONNECTED')) return '失败：网络未连接';
  return `失败：${message}`;
}

function getSnapshotSettingsKey(snapshot: AppSnapshot): string {
  return getInputSettingsKey({
    subscriptionUrl: snapshot.subscriptionUrl,
    ruleProfile: snapshot.ruleProfile,
    systemProxyEnabled: snapshot.features.systemProxyEnabled,
    dnsEnhanced: snapshot.features.dnsEnhanced,
    snifferEnabled: true,
    tunEnabled: snapshot.features.tunEnabled,
    strictRouteEnabled: snapshot.features.strictRouteEnabled,
    subscriptionRefreshIntervalHours: snapshot.features.subscriptionRefreshIntervalHours
  });
}

function getInputSettingsKey(settings: AppSettingsInput): string {
  return JSON.stringify({
    subscriptionUrl: settings.subscriptionUrl ?? '',
    ruleProfile: settings.ruleProfile ?? 'subscription',
    systemProxyEnabled: settings.systemProxyEnabled ?? true,
    dnsEnhanced: settings.dnsEnhanced ?? true,
    snifferEnabled: true,
    tunEnabled: settings.tunEnabled ?? false,
    strictRouteEnabled: settings.strictRouteEnabled ?? true,
    subscriptionRefreshIntervalHours: settings.subscriptionRefreshIntervalHours ?? 12
  });
}
