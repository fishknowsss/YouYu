import type { ProxyNode } from '../../shared/ipc';

type NodeListProps = {
  nodes: ProxyNode[];
  busy: boolean;
  switchingNode?: string;
  emptyText?: string;
  onSelect: (name: string) => void;
  onTestNode: (name: string) => void;
};

export function NodeList({ nodes, busy, switchingNode, emptyText = '先更新订阅', onSelect, onTestNode }: NodeListProps) {
  if (nodes.length === 0) {
    return <div className="empty">{emptyText}</div>;
  }

  return (
    <div className="node-list">
      {nodes.map((node) => {
        const switching = switchingNode === node.name;
        const className = ['node', node.active ? 'active' : '', switching ? 'switching' : '']
          .filter(Boolean)
          .join(' ');

        return (
          <div key={node.name} className={className}>
            <button className="node-main" disabled={busy || switching} onClick={() => onSelect(node.name)}>
              <span className="node-name">{node.name}</span>
              <span className={getDelayClass(node)}>{formatDelay(node, switching)}</span>
            </button>
            <button className="node-test" disabled={busy || switching} onClick={() => onTestNode(node.name)}>
              测
            </button>
          </div>
        );
      })}
    </div>
  );
}

function formatDelay(node: ProxyNode, switching: boolean): string {
  if (switching) return '切换中';
  if (node.testState === 'testing') return '测速中';
  if (typeof node.delay === 'number') return `${node.delay}ms`;
  if (node.testState === 'failed') return '不可用';
  return '未测';
}

function getDelayClass(node: ProxyNode): string {
  if (node.testState === 'testing') return 'delay delay-testing';
  if (node.testState === 'failed') return 'delay delay-failed';
  if (typeof node.delay !== 'number') return 'delay delay-unknown';
  if (node.delay <= 120) return 'delay delay-good';
  if (node.delay <= 260) return 'delay delay-ok';
  return 'delay delay-bad';
}
