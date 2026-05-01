import type { ProxyNode } from '../../shared/ipc';

type NodeListProps = {
  nodes: ProxyNode[];
  busy: boolean;
  emptyText?: string;
  onSelect: (name: string) => void;
  onTestNode: (name: string) => void;
};

export function NodeList({ nodes, busy, emptyText = '先更新订阅', onSelect, onTestNode }: NodeListProps) {
  if (nodes.length === 0) {
    return <div className="empty">{emptyText}</div>;
  }

  return (
    <div className="node-list">
      {nodes.map((node) => (
        <div key={node.name} className={node.active ? 'node active' : 'node'}>
          <button className="node-main" disabled={busy} onClick={() => onSelect(node.name)}>
            <span>{node.name}</span>
            <span className={getDelayClass(node.delay)}>{formatDelay(node.delay)}</span>
          </button>
          <button className="node-test" disabled={busy} onClick={() => onTestNode(node.name)}>
            测
          </button>
        </div>
      ))}
    </div>
  );
}

function formatDelay(delay: number | undefined): string {
  return typeof delay === 'number' ? `${delay}ms` : '--';
}

function getDelayClass(delay: number | undefined): string {
  if (typeof delay !== 'number') return 'delay delay-unknown';
  if (delay <= 120) return 'delay delay-good';
  if (delay <= 260) return 'delay delay-ok';
  return 'delay delay-bad';
}
