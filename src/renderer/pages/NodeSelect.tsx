import type { AppSnapshot } from '../../shared/ipc';
import { NodeList } from '../components/NodeList';

type NodeSelectProps = {
  snapshot: AppSnapshot;
  busy: boolean;
  message: string;
  onBack: () => void;
  onSelect: (name: string) => void;
  onTestNode: (name: string) => void;
  onTestAll: () => void;
  onRefresh: () => void;
};

export function NodeSelect({
  snapshot,
  busy,
  message,
  onBack,
  onSelect,
  onTestNode,
  onTestAll,
  onRefresh
}: NodeSelectProps) {
  const emptyText = snapshot.subscriptionUrl
    ? snapshot.status === 'running'
      ? '先更新订阅'
      : '启动后显示节点'
    : '先保存订阅';

  return (
    <div className="workspace fill-space">
      <div className="workspace-header">
        <div>
          <span className="section-label">节点管理</span>
          <h1>节点</h1>
          <p>当前：{snapshot.currentNode}</p>
        </div>
        <div className="header-actions">
          <button className="secondary-button" onClick={onBack}>返回</button>
          <button className="wide-button" disabled={busy} onClick={onTestAll}>测速全部</button>
          <button className="secondary-button" disabled={busy} onClick={onRefresh}>
            {snapshot.status === 'running' ? '更新订阅' : '启动更新'}
          </button>
        </div>
      </div>
      <section className="panel list-panel">
        <NodeList
          nodes={snapshot.nodes}
          busy={busy}
          emptyText={emptyText}
          onSelect={onSelect}
          onTestNode={onTestNode}
        />
      </section>
      {message ? <p className="inline-message">{message}</p> : null}
    </div>
  );
}
