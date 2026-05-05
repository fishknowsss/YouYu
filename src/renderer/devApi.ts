import type {
  AppSnapshot,
  ConnectivityResult,
  ConnectivityServiceKey,
  DesktopPetState,
  MihomoMode,
  ProxyNode,
  StrategyKey,
  YouYuApi
} from '../shared/ipc';

const baseNodes: ProxyNode[] = [
  { name: '自动选择', delay: 92 },
  { name: '香港 01', delay: 118 },
  { name: '香港 02', delay: 151 },
  { name: '日本 01', delay: 96 },
  { name: '新加坡 01', delay: 138 }
];

const devConnectivity: Array<{
  key: ConnectivityServiceKey;
  name: string;
  url: string;
  category: ConnectivityResult['category'];
  totalMs: number;
  ip?: string;
  region?: string;
}> = [
  { key: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com', category: 'ai', totalMs: 286, ip: '126.63.231.113', region: 'Japan' },
  { key: 'claude', name: 'Claude', url: 'https://claude.ai', category: 'ai', totalMs: 312, ip: '126.63.231.113', region: 'Japan' },
  { key: 'gemini', name: 'Gemini', url: 'https://gemini.google.com', category: 'ai', totalMs: 248 },
  { key: 'flow', name: 'Flow', url: 'https://labs.google/fx/tools/flow', category: 'special', totalMs: 338 },
  { key: 'runway', name: 'Runway', url: 'https://app.runwayml.com', category: 'ai', totalMs: 428 },
  { key: 'bytedance', name: '字节跳动', url: 'https://www.bytedance.com', category: 'global', totalMs: 198 },
  { key: 'tencent', name: '腾讯', url: 'https://www.tencent.com', category: 'domestic', totalMs: 126 },
  { key: 'google', name: 'Google', url: 'https://www.google.com', category: 'global', totalMs: 168 },
  { key: 'x', name: 'X', url: 'https://x.com', category: 'global', totalMs: 226, ip: '216.236.40.177', region: 'Hong Kong' },
  { key: 'cloudflare', name: 'Cloudflare', url: 'https://www.cloudflare.com', category: 'global', totalMs: 198, ip: '216.236.40.177', region: 'Hong Kong' },
  { key: 'ehentai', name: 'E-Hentai', url: 'https://e-hentai.org', category: 'global', totalMs: 214, ip: '216.236.40.177', region: 'Hong Kong' }
];

export function createDevYouYuApi(): YouYuApi {
  let petState: DesktopPetState = 'idle';
  const petListeners = new Set<(state: DesktopPetState) => void>();
  let snapshot: AppSnapshot = {
    status: 'stopped',
    currentNode: '自动选择',
    nodes: [],
    strategies: createStrategies('auto'),
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'subscription',
    features: {
      systemProxyEnabled: true,
      dnsEnhanced: false,
      snifferEnabled: true,
      tunEnabled: true,
      strictRouteEnabled: true,
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

  function publishPet(next: DesktopPetState) {
    petState = next;
    petListeners.forEach((listener) => listener(petState));
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
    onPetStateUpdated(listener) {
      petListeners.add(listener);
      listener(petState);
      return () => {
        petListeners.delete(listener);
      };
    },
    async wavePet() {
      publishPet('wave');
      return undefined;
    },
    async startPetDrag() {
      publishPet('drag');
      return undefined;
    },
    async stopPetDrag(moved = false) {
      const next = moved ? 'fallRecover' : snapshot.status === 'running' ? 'happy' : 'idle';
      publishPet(next);
      return next;
    },
    async showMainWindow() {
      return undefined;
    },
    async start() {
      requireSubscription();
      publishPet('happy');
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
      publishPet('idle');
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
      publishPet('focusWait');
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
    async testConnectivity(key) {
      return createDevConnectivityResult(key);
    },
    async testAllConnectivity() {
      return devConnectivity.map((service) => createDevConnectivityResult(service.key));
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
      publishPet('happy');
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
          strictRouteEnabled: settings.strictRouteEnabled ?? snapshot.features.strictRouteEnabled,
          allowLan: settings.allowLan ?? snapshot.features.allowLan
        },
        nodes: snapshot.status === 'running' ? withNodes() : snapshot.nodes
      });
    }
  };
}

function createDevConnectivityResult(key: ConnectivityServiceKey): ConnectivityResult {
  const service = devConnectivity.find((item) => item.key === key) ?? devConnectivity[0];
  return {
    key: service.key,
    name: service.name,
    url: service.url,
    category: service.category,
    status: 'available',
    statusText: '可用',
    reachability: 'ok',
    checkedAt: new Date().toISOString(),
    httpCode: 200,
    finalUrl: service.url,
    region: service.region,
    ip: service.ip,
    colo: service.ip ? 'TPE' : undefined,
    timings: {
      connectMs: Math.max(18, service.totalMs - 210),
      tlsMs: Math.max(42, service.totalMs - 160),
      firstByteMs: Math.max(66, service.totalMs - 80),
      totalMs: service.totalMs
    },
    rule: 'DOMAIN-SUFFIX',
    rulePayload: service.key,
    chains: ['MESL', '台湾 08 家宽']
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
