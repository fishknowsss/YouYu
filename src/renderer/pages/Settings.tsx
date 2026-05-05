import { useEffect, useState } from 'react';
import type { AppSettingsInput, AppSnapshot, RuleProfile } from '../../shared/ipc';

type SettingsProps = {
  snapshot: AppSnapshot;
  busy: boolean;
  message: string;
  onBack: () => void;
  onRepair: () => void;
  onSave: (settings: AppSettingsInput) => void;
};

export function Settings({ snapshot, busy, message, onBack, onRepair, onSave }: SettingsProps) {
  const [subscriptionUrl, setSubscriptionUrl] = useState(snapshot.subscriptionUrl);
  const [ruleProfile, setRuleProfile] = useState<RuleProfile>(snapshot.ruleProfile);
  const [systemProxyEnabled, setSystemProxyEnabled] = useState(snapshot.features.systemProxyEnabled);
  const [dnsEnhanced, setDnsEnhanced] = useState(snapshot.features.dnsEnhanced);
  const [snifferEnabled, setSnifferEnabled] = useState(snapshot.features.snifferEnabled);
  const [tunEnabled, setTunEnabled] = useState(snapshot.features.tunEnabled);
  const [strictRouteEnabled, setStrictRouteEnabled] = useState(snapshot.features.strictRouteEnabled);

  useEffect(() => {
    setSubscriptionUrl(snapshot.subscriptionUrl);
    setRuleProfile(snapshot.ruleProfile);
    setSystemProxyEnabled(snapshot.features.systemProxyEnabled);
    setDnsEnhanced(snapshot.features.dnsEnhanced);
    setSnifferEnabled(snapshot.features.snifferEnabled);
    setTunEnabled(snapshot.features.tunEnabled);
    setStrictRouteEnabled(snapshot.features.strictRouteEnabled);
  }, [snapshot]);

  function save() {
    onSave({
      subscriptionUrl,
      ruleProfile,
      systemProxyEnabled,
      dnsEnhanced,
      snifferEnabled,
      tunEnabled,
      strictRouteEnabled
    });
  }

  return (
    <div className="workspace">
      <div className="workspace-header">
        <div>
          <h1>设置</h1>
          <p>订阅与网络开关</p>
        </div>
        <button className="secondary-button" onClick={onBack}>返回</button>
      </div>
      <section className="panel settings-panel">
        <div className="form-grid">
          <label className="field field-wide">
            <span>订阅</span>
            <input
              value={subscriptionUrl}
              onChange={(event) => setSubscriptionUrl(event.target.value)}
              placeholder="https://..."
            />
          </label>
          <label className="field">
            <span>规则来源</span>
            <select
              value={ruleProfile}
              onChange={(event) => setRuleProfile(event.target.value as RuleProfile)}
            >
              <option value="smart">智能分流</option>
              <option value="global">全部代理</option>
              <option value="subscription">机场配置</option>
            </select>
          </label>
        </div>
        <div className="toggle-grid">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={systemProxyEnabled}
              onChange={(event) => setSystemProxyEnabled(event.target.checked)}
            />
            <span>系统代理</span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={dnsEnhanced}
              onChange={(event) => setDnsEnhanced(event.target.checked)}
            />
            <span>DNS 增强</span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={snifferEnabled}
              onChange={(event) => setSnifferEnabled(event.target.checked)}
            />
            <span>流量嗅探</span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={tunEnabled}
              onChange={(event) => setTunEnabled(event.target.checked)}
            />
            <span>TUN</span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={strictRouteEnabled}
              onChange={(event) => setStrictRouteEnabled(event.target.checked)}
            />
            <span>严格路由</span>
          </label>
        </div>
        <div className="settings-actions">
          <button className="wide-button" disabled={busy} onClick={save}>
            保存
          </button>
          <button className="secondary-button" disabled={busy} onClick={onRepair}>
            修复
          </button>
        </div>
        <p className="inline-message">{message || ' '}</p>
      </section>
    </div>
  );
}
