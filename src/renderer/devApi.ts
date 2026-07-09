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

declare const __YOUYU_APP_VERSION__: string;
declare const __YOUYU_BUILD_CHANNEL__: 'standard' | 'in' | 'no' | string;

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
  { key: 'steam', name: 'Steam', url: 'https://store.steampowered.com', category: 'special', totalMs: 142, ip: '23.203.232.145', region: 'Japan' },
  { key: 'steamNetwork', name: 'Steam 联机', url: 'https://api.steampowered.com', category: 'special', totalMs: 166, ip: '23.203.232.145', region: 'Japan' },
  { key: 'steamCloud', name: 'Steam 云同步', url: 'https://steamcloud-ugc.storage.googleapis.com', category: 'special', totalMs: 184, ip: '172.217.25.176', region: 'Japan' },
  { key: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com', category: 'ai', totalMs: 286, ip: '126.63.231.113', region: 'Japan' },
  { key: 'claude', name: 'Claude', url: 'https://claude.ai', category: 'ai', totalMs: 312, ip: '126.63.231.113', region: 'Japan' },
  { key: 'gemini', name: 'Gemini', url: 'https://gemini.google.com', category: 'ai', totalMs: 248 },
  { key: 'flow', name: 'Flow', url: 'https://labs.google/fx/tools/flow', category: 'special', totalMs: 338 },
  { key: 'pixverse', name: 'PixVerse', url: 'https://app.pixverse.ai', category: 'ai', totalMs: 428 },
  { key: 'github', name: 'GitHub', url: 'https://github.com', category: 'global', totalMs: 194 },
  { key: 'microsoftStore', name: 'Microsoft 商店', url: 'https://apps.microsoft.com', category: 'special', totalMs: 232 },
  { key: 'discord', name: 'Discord', url: 'https://discord.com', category: 'special', totalMs: 266 },
  { key: 'turnstile', name: 'Cloudflare 验证', url: 'https://challenges.cloudflare.com', category: 'special', totalMs: 188 },
  { key: 'recaptcha', name: 'Google 验证', url: 'https://www.recaptcha.net', category: 'special', totalMs: 246 },
  { key: 'hcaptcha', name: 'hCaptcha', url: 'https://js.hcaptcha.com', category: 'special', totalMs: 221 },
  { key: 'google', name: 'Google', url: 'https://www.google.com', category: 'global', totalMs: 168 },
  { key: 'cloudflare', name: 'Cloudflare', url: 'https://www.cloudflare.com', category: 'global', totalMs: 198, ip: '216.236.40.177', region: 'Hong Kong' }
];

export function createDevYouYuApi(): YouYuApi {
  let petState: DesktopPetState = 'idle';
  const petListeners = new Set<(state: DesktopPetState) => void>();
  const petSequenceTimers = new Set<number>();
  let snapshot: AppSnapshot = {
    status: 'stopped',
    currentNode: '自动选择',
    nodes: [],
    nodeHealth: createDevNodeHealth('自动选择'),
    strategies: createStrategies('auto'),
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'ruleset',
    features: {
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled: false,
      strictRouteEnabled: true,
      allowLan: false,
      subscriptionRefreshIntervalHours: 12
    },
    runtime: {
      activeConnections: 0,
      uploadTotal: 0,
      downloadTotal: 0
    },
    traffic: {
      totalUpload: 0,
      totalDownload: 0,
      todayUpload: 0,
      todayDownload: 0,
      pendingUpload: 0,
      pendingDownload: 0,
      nodeUsage: {},
      reportStatus: 'idle'
    },
    subscriptionUrl: '',
    update: {
      currentVersion: __YOUYU_APP_VERSION__,
      buildChannel: getDevBuildChannel(),
      updateChannel: getDevUpdateChannel(),
      status: 'idle'
    },
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

  function clearPetSequenceTimers() {
    petSequenceTimers.forEach((timer) => window.clearTimeout(timer));
    petSequenceTimers.clear();
  }

  function getRuntimePetState(): DesktopPetState {
    return snapshot.status === 'running' ? 'happy' : 'idle';
  }

  function publishPetLater(next: DesktopPetState | (() => DesktopPetState), delayMs: number) {
    const timer = window.setTimeout(() => {
      petSequenceTimers.delete(timer);
      publishPet(typeof next === 'function' ? next() : next);
    }, delayMs);
    petSequenceTimers.add(timer);
  }

  function playDevDropSequence() {
    clearPetSequenceTimers();
    publishPet('fallRecover');
    publishPetLater('bottomDizzy', 820);
    publishPetLater('bottomAngry', 1450);
    publishPetLater('idle', 2400);
    publishPetLater(getRuntimePetState, 6600);
  }

  function requireSubscription() {
    if (!snapshot.subscriptionUrl.trim()) {
      throw new Error('missing subscription url');
    }
  }

  function requireTrafficIdentity() {
    if (!snapshot.trafficIdentity) {
      throw new Error('traffic identity required');
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
      clearPetSequenceTimers();
      publishPet('wave');
      return undefined;
    },
    async startPetDrag() {
      clearPetSequenceTimers();
      publishPet('drag');
      return undefined;
    },
    async stopPetDrag(moved = false) {
      if (moved) {
        playDevDropSequence();
        return 'fallRecover';
      }
      clearPetSequenceTimers();
      const next = getRuntimePetState();
      publishPet(next);
      return next;
    },
    async setPetMousePassthrough() {
      return undefined;
    },
    async showMainWindow() {
      return undefined;
    },
    async start() {
      requireTrafficIdentity();
      requireSubscription();
      clearPetSequenceTimers();
      publishPet('happy');
      return publish({
        status: 'running',
        nodes: withNodes(),
        nodeHealth: createDevNodeHealth(snapshot.currentNode, 92),
        runtime: {
          activeConnections: 4,
          uploadTotal: 728493,
          downloadTotal: 5829342
        }
      });
    },
    async stop() {
      clearPetSequenceTimers();
      publishPet('idle');
      return publish({
        status: 'stopped',
        nodes: [],
        nodeHealth: createDevNodeHealth(snapshot.currentNode),
        runtime: {
          activeConnections: 0,
          uploadTotal: 0,
          downloadTotal: 0
        }
      });
    },
    async repair() {
      clearPetSequenceTimers();
      publishPet('focusWait');
      return publish({
        status: 'stopped',
        nodes: [],
        nodeHealth: createDevNodeHealth(snapshot.currentNode),
        runtime: {
          activeConnections: 0,
          uploadTotal: 0,
          downloadTotal: 0
        }
      });
    },
    async selectNode(name) {
      requireTrafficIdentity();
      return publish({
        strategy: 'manual',
        currentNode: name,
        nodes: withNodes(name),
        nodeHealth: createDevNodeHealth(name, 96),
        strategies: createStrategies('manual')
      });
    },
    async selectBestAutoNode() {
      requireTrafficIdentity();
      const bestNode = snapshot.nodes
        .filter((node) => typeof node.delay === 'number')
        .sort((left, right) => (left.delay ?? Number.MAX_SAFE_INTEGER) - (right.delay ?? Number.MAX_SAFE_INTEGER))[0];
      const currentNode = bestNode?.name ?? '自动选择';
      return publish({
        strategy: 'auto',
        currentNode,
        nodes: withNodes(currentNode),
        nodeHealth: createDevNodeHealth(currentNode, bestNode?.delay ?? 92),
        strategies: createStrategies('auto')
      });
    },
    async selectStrategy(strategy) {
      return publish({
        strategy,
        currentNode: strategyLabel(strategy),
        strategies: createStrategies(strategy),
        nodeHealth: createDevNodeHealth(strategyLabel(strategy), strategy === 'direct' ? undefined : 92),
        nodes: withNodes()
      });
    },
    async setMode(mode: MihomoMode) {
      return publish({ mode });
    },
    async testNode(name) {
      requireTrafficIdentity();
      return publish({
        nodes: snapshot.nodes.map((node) =>
          node.name === name ? { ...node, delay: Math.max(68, node.delay ?? 120) } : node
        ),
        nodeHealth:
          snapshot.currentNode === name
            ? createDevNodeHealth(name, Math.max(68, snapshot.nodes.find((node) => node.name === name)?.delay ?? 120))
            : snapshot.nodeHealth
      });
    },
    async testAllNodes() {
      requireTrafficIdentity();
      return publish({
        nodes: withNodes(snapshot.currentNode).map((node, index) => ({
          ...node,
          delay: 78 + index * 19
        })),
        nodeHealth: createDevNodeHealth(snapshot.currentNode, 78)
      });
    },
    async cancelNodeTests() {
      return structuredClone(snapshot);
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
      requireTrafficIdentity();
      requireSubscription();
      clearPetSequenceTimers();
      publishPet('happy');
      return publish({
        status: 'running',
        nodes: withNodes(),
        nodeHealth: createDevNodeHealth(snapshot.currentNode, 92),
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
          systemProxyEnabled: true,
          dnsEnhanced: true,
          snifferEnabled: true,
          tunEnabled: settings.tunEnabled ?? snapshot.features.tunEnabled,
          strictRouteEnabled: true,
          allowLan: settings.allowLan ?? snapshot.features.allowLan,
          subscriptionRefreshIntervalHours:
            settings.subscriptionRefreshIntervalHours ??
            snapshot.features.subscriptionRefreshIntervalHours
        },
        nodes: snapshot.status === 'running' ? withNodes() : snapshot.nodes
      });
    },
    async registerTrafficIdentity(input) {
      const name = input.name.trim();
      if (!name) throw new Error('missing traffic user name');
      if (!input.passphrase.trim()) throw new Error('missing traffic passphrase');
      return publish({
        trafficIdentity: {
          userId: `dev-${name}`,
          deviceId: 'dev-device',
          name,
          deviceName: 'Dev PC',
          registeredAt: new Date().toISOString()
        },
        traffic: {
          ...snapshot.traffic,
          reportStatus: 'synced'
        }
      });
    },
    async syncRemoteConfig() {
      requireTrafficIdentity();
      return publish({
        remoteSubscriptionUrl: snapshot.remoteSubscriptionUrl,
        subscriptionUrl: snapshot.subscriptionUrl
      });
    },
    async checkForUpdates() {
      return publish({
        update: {
          currentVersion: snapshot.update.currentVersion,
          buildChannel: snapshot.update.buildChannel,
          updateChannel: snapshot.update.updateChannel,
          status: 'not-available',
          checkedAt: new Date().toISOString()
        }
      });
    },
    async installUpdate() {
      return structuredClone(snapshot);
    }
  };
}

function getDevBuildChannel(): AppSnapshot['update']['buildChannel'] {
  if (__YOUYU_BUILD_CHANNEL__ === 'in' || __YOUYU_BUILD_CHANNEL__ === 'no') return __YOUYU_BUILD_CHANNEL__;
  return 'standard';
}

function getDevUpdateChannel(): string {
  const channel = getDevBuildChannel();
  if (channel === 'in') return 'latest-in';
  if (channel === 'no') return 'latest-no';
  return 'latest';
}

function createDevNodeHealth(nodeName: string, delay?: number): AppSnapshot['nodeHealth'] {
  const checkedAt = new Date().toISOString();
  const totalCount = devConnectivity.length;
  const availableCount = Math.min(totalCount, Math.max(0, Math.ceil(totalCount * 0.88)));
  const percent = totalCount > 0 ? Math.round((availableCount / totalCount) * 100) : 0;
  return {
    nodeName,
    delayStatus: typeof delay === 'number' ? 'measured' : 'untested',
    delay,
    delayCheckedAt: typeof delay === 'number' ? checkedAt : undefined,
    availability:
      typeof delay === 'number'
        ? {
            status: 'measured',
            totalCount,
            availableCount,
            percent,
            tone: getDevAvailabilityTone(percent),
            checkedAt
          }
        : {
            status: 'untested',
            totalCount
          }
  };
}

function getDevAvailabilityTone(percent: number): AppSnapshot['nodeHealth']['availability']['tone'] {
  if (percent < 60) return 'danger';
  if (percent < 85) return 'warning';
  return 'success';
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
