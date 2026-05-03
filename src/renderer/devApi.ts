import type { AppSnapshot, MihomoMode, ProxyNode, StrategyKey, YouYuApi } from '../shared/ipc';

const baseNodes: ProxyNode[] = [
  { name: '自动选择', delay: 92 },
  { name: '香港 01', delay: 118 },
  { name: '香港 02', delay: 151 },
  { name: '日本 01', delay: 96 },
  { name: '新加坡 01', delay: 138 }
];

export function createDevYouYuApi(): YouYuApi {
  let snapshot: AppSnapshot = {
    status: 'stopped',
    currentNode: '自动选择',
    nodes: [],
    strategies: createStrategies('auto'),
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'smart',
    features: {
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled: false,
      allowLan: false
    },
    runtime: {
      activeConnections: 0,
      uploadTotal: 0,
      downloadTotal: 0
    },
    subscriptionUrl: '',
    diagnostics: {
      logs: []
    }
  };

  function withNodes(currentNode = snapshot.currentNode): ProxyNode[] {
    return baseNodes.map((node) => ({
      ...node,
      active: node.name === currentNode
    }));
  }

  function publish(next: Partial<AppSnapshot>): AppSnapshot {
    snapshot = {
      ...snapshot,
      ...next
    };
    return structuredClone(snapshot);
  }

  function requireSubscription() {
    if (!snapshot.subscriptionUrl.trim()) {
      throw new Error('missing subscription url');
    }
  }

  return {
    async getSnapshot() {
      return structuredClone(snapshot);
    },
    onSnapshotUpdated() {
      return () => undefined;
    },
    async start() {
      requireSubscription();
      return publish({
        status: 'running',
        nodes: withNodes(),
        runtime: {
          activeConnections: 4,
          uploadTotal: 728493,
          downloadTotal: 5829342
        }
      });
    },
    async stop() {
      return publish({
        status: 'stopped',
        nodes: [],
        runtime: {
          activeConnections: 0,
          uploadTotal: 0,
          downloadTotal: 0
        }
      });
    },
    async repair() {
      return publish({
        status: 'stopped',
        nodes: [],
        runtime: {
          activeConnections: 0,
          uploadTotal: 0,
          downloadTotal: 0
        }
      });
    },
    async selectNode(name) {
      return publish({
        strategy: 'manual',
        currentNode: name,
        nodes: withNodes(name),
        strategies: createStrategies('manual')
      });
    },
    async selectStrategy(strategy) {
      return publish({
        strategy,
        currentNode: strategyLabel(strategy),
        strategies: createStrategies(strategy),
        nodes: withNodes()
      });
    },
    async setMode(mode: MihomoMode) {
      return publish({ mode });
    },
    async testNode(name) {
      return publish({
        nodes: snapshot.nodes.map((node) =>
          node.name === name ? { ...node, delay: Math.max(68, node.delay ?? 120) } : node
        )
      });
    },
    async testAllNodes() {
      return publish({
        nodes: withNodes(snapshot.currentNode).map((node, index) => ({
          ...node,
          delay: 78 + index * 19
        }))
      });
    },
    async closeConnections() {
      return publish({
        runtime: {
          ...snapshot.runtime,
          activeConnections: 0
        }
      });
    },
    async updateSubscription() {
      requireSubscription();
      return publish({
        status: 'running',
        nodes: withNodes(),
        runtime: {
          activeConnections: 4,
          uploadTotal: 728493,
          downloadTotal: 5829342
        }
      });
    },
    async saveSettings(settings) {
      return publish({
        subscriptionUrl:
          typeof settings.subscriptionUrl === 'string'
            ? settings.subscriptionUrl.trim()
            : snapshot.subscriptionUrl,
        mode: settings.mode ?? snapshot.mode,
        strategy: settings.strategy ?? snapshot.strategy,
        ruleProfile: settings.ruleProfile ?? snapshot.ruleProfile,
        features: {
          ...snapshot.features,
          systemProxyEnabled: settings.systemProxyEnabled ?? snapshot.features.systemProxyEnabled,
          dnsEnhanced: settings.dnsEnhanced ?? snapshot.features.dnsEnhanced,
          snifferEnabled: settings.snifferEnabled ?? snapshot.features.snifferEnabled,
          tunEnabled: settings.tunEnabled ?? snapshot.features.tunEnabled,
          allowLan: settings.allowLan ?? snapshot.features.allowLan
        },
        nodes: snapshot.status === 'running' ? withNodes() : snapshot.nodes
      });
    }
  };
}

function createStrategies(active: StrategyKey) {
  const strategies: Array<{ key: StrategyKey; label: string; target: string }> = [
    { key: 'auto', label: '自动', target: '自动选择' },
    { key: 'fallback', label: '故障转移', target: '故障转移' },
    { key: 'load-balance', label: '均衡', target: '负载均衡' },
    { key: 'direct', label: '直连', target: 'DIRECT' }
  ];

  return strategies.map((strategy) => ({
    ...strategy,
    active: strategy.key === active,
    now: strategy.key === 'auto' ? '香港 01' : undefined,
    delay: strategy.key === 'auto' ? 92 : undefined
  }));
}

function strategyLabel(strategy: StrategyKey): string {
  if (strategy === 'fallback') return '故障转移';
  if (strategy === 'load-balance') return '负载均衡';
  if (strategy === 'direct') return 'DIRECT';
  return '自动选择';
}

export function installDevApiFallback() {
  if (import.meta.env.DEV && !window.youyu) {
    window.youyu = createDevYouYuApi();
  }
}
