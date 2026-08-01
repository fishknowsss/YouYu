import { memo } from 'react';
import type { AppSnapshot } from '../../shared/ipc';
import { NodeList } from '../components/NodeList';
import { WorkspaceHeader } from '../components/WorkspaceHeader';

type NodeSelectProps = {
  snapshot: AppSnapshot;
  busy: boolean;
  message: string;
  testingAll: boolean;
  switchingNode?: string;
  onSelect: (name: string) => void;
  onTestNode: (name: string) => void;
  onTestAll: () => void;
  onCancelTestAll: () => void;
  onRefresh: () => void;
};

export const NodeSelect = memo(NodeSelectView, areNodeSelectPropsEqual);

function NodeSelectView({
  snapshot,
  busy,
  message,
  testingAll,
  switchingNode,
  onSelect,
  onTestNode,
  onTestAll,
  onCancelTestAll,
  onRefresh
}: NodeSelectProps) {
  const emptyText = snapshot.subscriptionUrl
    ? snapshot.status === 'running'
      ? '先更新订阅'
      : '启动后显示节点'
    : '先保存订阅';

  return (
    <div className="workspace fill-space">
      <WorkspaceHeader
        title="节点"
        description={`当前出口：${snapshot.currentNode}`}
        actions={
          <>
            <button
              className="wide-button"
              disabled={busy && !testingAll}
              onClick={testingAll ? onCancelTestAll : onTestAll}
            >
              {testingAll ? '停止' : '全部测速'}
            </button>
            <button className="secondary-button" disabled={busy} onClick={onRefresh}>
              {snapshot.status === 'running' ? '更新订阅' : '启动并更新'}
            </button>
          </>
        }
      />
      <section className="panel list-panel">
        <NodeList
          nodes={snapshot.nodes}
          selectionBusy={busy && !testingAll}
          testingBusy={busy}
          switchingNode={switchingNode}
          emptyText={emptyText}
          onSelect={onSelect}
          onTestNode={onTestNode}
        />
      </section>
      <p className="inline-message">{message || ' '}</p>
    </div>
  );
}

function areNodeSelectPropsEqual(previous: NodeSelectProps, next: NodeSelectProps): boolean {
  return (
    previous.busy === next.busy &&
    previous.message === next.message &&
    previous.testingAll === next.testingAll &&
    previous.switchingNode === next.switchingNode &&
    previous.onSelect === next.onSelect &&
    previous.onTestNode === next.onTestNode &&
    previous.onTestAll === next.onTestAll &&
    previous.onCancelTestAll === next.onCancelTestAll &&
    previous.onRefresh === next.onRefresh &&
    getNodeSelectRenderKey(previous.snapshot) === getNodeSelectRenderKey(next.snapshot)
  );
}

export function getNodeSelectRenderKey(snapshot: AppSnapshot): string {
  return JSON.stringify([
    snapshot.subscriptionUrl,
    snapshot.status,
    snapshot.currentNode,
    snapshot.nodes.map((node) => [node.name, node.delay ?? null, node.active ?? false, node.testState ?? ''])
  ]);
}
