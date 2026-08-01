import type {
  MihomoMode,
  ProxyNode,
  RuntimeConnectionStats,
  RuntimeStats,
  StrategyGroup,
  StrategyKey
} from '../../shared/ipc';
import { isBlockedSelectableNodeName, strategyLabels, strategyTargets } from './config';

type Fetcher = typeof fetch;

type MihomoProxyItem = {
  type?: string;
  now?: string;
  all?: string[];
  history?: Array<{ delay?: number }>;
};

type MihomoProxiesResponse = {
  proxies?: Record<string, MihomoProxyItem>;
};

type MihomoProviderNode = {
  provider: string;
  name: string;
  item: MihomoProxyItem;
};

export type MihomoApiClient = {
  listNodes: () => Promise<ProxyNode[]>;
  listStrategies: () => Promise<StrategyGroup[]>;
  getCurrentNode: () => Promise<string>;
  getRuntimeStats: (options?: { includeConnections?: boolean }) => Promise<RuntimeStats>;
  selectNode: (name: string) => Promise<void>;
  selectStrategy: (strategy: StrategyKey) => Promise<void>;
  setMode: (mode: MihomoMode) => Promise<void>;
  testNodeDelay: (name: string, options?: { signal?: AbortSignal }) => Promise<number | undefined>;
  testAllNodes: (options?: {
    signal?: AbortSignal;
    onNodeTested?: (node: ProxyNode) => void | Promise<void>;
  }) => Promise<void>;
  selectBestUsableNode: (options?: { avoidNode?: string; signal?: AbortSignal }) => Promise<string | undefined>;
  selectBestUsableNodeForStrategy: (
    strategy: Exclude<StrategyKey, 'manual' | 'direct'>,
    options?: { avoidNode?: string; signal?: AbortSignal }
  ) => Promise<string | undefined>;
  closeConnections: () => Promise<void>;
  flushDnsCache: () => Promise<void>;
  updateProvider: (options?: { signal?: AbortSignal }) => Promise<void>;
};

const selectorName = '节点选择';
const providerName = 'airport';
const delayTestUrls = ['https://www.gstatic.com/generate_204', 'https://cp.cloudflare.com/generate_204'];
const delayTestTimeoutMs = 2000;
const delayTestConcurrency = 6;
const nodeDelayCache = new Map<string, number>();
const nodeTestStateCache = new Map<string, ProxyNode['testState']>();
type NodeTestOwner = {
  token: symbol;
  baselineState: ProxyNode['testState'];
};
const nodeTestOwners = new Map<string, NodeTestOwner>();
const nodeProviderCache = new Map<string, string>();
const builtInProxyNames = new Set(['COMPATIBLE', 'DIRECT', 'PASS', 'REJECT', 'REJECT-DROP']);
const effectiveCurrentGroupNames = ['Final', 'GLOBAL', 'MESL'];
const requiredSyncedGroupNames = new Set([selectorName, ...effectiveCurrentGroupNames]);
const strategyTargetSet = new Set<string>([...Object.values(strategyTargets), ...builtInProxyNames]);
const preferredJapanNodePatterns = [
  /(?:^|[^a-z0-9])(?:jp|jpn|japan|tokyo|osaka)(?:$|[^a-z0-9])/i,
  /(?:\u65e5\u672c|\u4e1c\u4eac|\u5927\u962a|\u{1f1ef}\u{1f1f5})/iu
];

type MihomoConnectionsResponse = {
  uploadTotal?: number;
  downloadTotal?: number;
  connections?: RuntimeConnectionStats[];
};

type MihomoDelayResponse = {
  delay?: number;
};

type MihomoProvidersResponse = {
  providers?: Record<string, unknown>;
};

export function createMihomoApiClient(options: {
  secret: string;
  controllerPort?: number;
  fetcher?: Fetcher;
  requestTimeoutMs?: number;
}): MihomoApiClient {
  const fetcher = options.fetcher ?? fetch;
  const controllerUrl = `http://127.0.0.1:${options.controllerPort ?? 9090}`;

  function headers(extra?: Record<string, string>) {
    return {
      Authorization: `Bearer ${options.secret}`,
      ...extra
    };
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(options.requestTimeoutMs ?? 5000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetcher(`${controllerUrl}${path}`, { ...init, signal });
    if (!response.ok) {
      throw new Error(`mihomo api failed: ${response.status}`);
    }
    return response;
  }

  async function readProxies(): Promise<MihomoProxiesResponse> {
    const response = await request('/proxies', {
      headers: headers()
    });
    return (await response.json()) as MihomoProxiesResponse;
  }

  async function readProviders(): Promise<MihomoProvidersResponse> {
    const response = await request('/providers/proxies', {
      headers: headers()
    });
    return (await response.json()) as MihomoProvidersResponse;
  }

  function findSelector(proxies: Record<string, MihomoProxyItem>): { name: string; item: MihomoProxyItem } | null {
    const preferred = proxies[selectorName];
    if (preferred?.all?.length) {
      return { name: selectorName, item: preferred };
    }

    const selectors = Object.entries(proxies)
      .map(([name, item]) => ({
        name,
        item,
        nodes: item.all?.length ? collectSelectableNodes(proxies, item.all).length : 0
      }))
      .filter(({ name, item, nodes }) => {
        return nodes > 0 && item.all?.length && !builtInProxyNames.has(name);
      })
      .sort(
        (left, right) =>
          scoreSelector(right.name, right.item, right.nodes) - scoreSelector(left.name, left.item, left.nodes)
      );

    const selector = selectors[0];

    return selector ? { name: selector.name, item: selector.item } : null;
  }

  function scoreSelector(name: string, item: MihomoProxyItem, nodeCount: number): number {
    const type = item.type?.toLowerCase() ?? '';
    let score = nodeCount;
    if (type === 'selector' || type === 'select') score += 10000;
    if (/节点|选择|代理|proxy|proxies|global|final|select/i.test(name)) score += 5000;
    if (strategyTargetSet.has(name)) score -= 2000;
    if (/urltest|url-test|fallback|load-balance|loadbalance/i.test(type)) score -= 2000;
    return score;
  }

  function findCurrentSelector(proxies: Record<string, MihomoProxyItem>): MihomoProxyItem | undefined {
    const managedSelector = proxies[selectorName];
    if (managedSelector?.all?.length) {
      return managedSelector;
    }

    for (const name of effectiveCurrentGroupNames) {
      const item = proxies[name];
      if (item?.all?.length) {
        return item;
      }
    }

    return findSelector(proxies)?.item;
  }

  function latestDelay(item: MihomoProxyItem | undefined): number | undefined {
    const delay = item?.history?.findLast((entry) => typeof entry.delay === 'number')?.delay;
    return normalizeDelay(delay);
  }

  function cachedDelay(name: string, item: MihomoProxyItem | undefined): number | undefined {
    return nodeDelayCache.get(name) ?? latestDelay(item);
  }

  function cachedTestState(name: string): ProxyNode['testState'] {
    return nodeTestStateCache.get(name);
  }

  function beginNodeTest(name: string): NodeTestOwner {
    const current = nodeTestOwners.get(name);
    const owner = {
      token: Symbol(name),
      baselineState: current?.baselineState ?? nodeTestStateCache.get(name)
    };
    nodeTestOwners.set(name, owner);
    nodeTestStateCache.set(name, 'testing');
    return owner;
  }

  function ownsNodeTest(name: string, owner: NodeTestOwner): boolean {
    return nodeTestOwners.get(name)?.token === owner.token;
  }

  function restoreOwnedTestState(name: string, owner: NodeTestOwner): void {
    if (!ownsNodeTest(name, owner)) return;
    if (owner.baselineState) {
      nodeTestStateCache.set(name, owner.baselineState);
    } else {
      nodeTestStateCache.delete(name);
    }
    nodeTestOwners.delete(name);
  }

  function normalizeDelay(delay: unknown): number | undefined {
    return typeof delay === 'number' && delay > 0 && delay < delayTestTimeoutMs ? delay : undefined;
  }

  function resolveCurrentNode(proxies: Record<string, MihomoProxyItem>, selector: MihomoProxyItem | undefined) {
    const current = selector?.now ?? strategyTargets.auto;
    return (
      resolveProxyNode(proxies, current, new Set()) ??
      collectSelectableNodes(proxies, selector?.all ?? [])[0] ??
      current
    );
  }

  function resolveProxyNode(
    proxies: Record<string, MihomoProxyItem>,
    name: string,
    visited: Set<string>
  ): string | undefined {
    if (name === 'DIRECT') {
      return name;
    }

    const item = proxies[name];
    if (!item?.all?.length) {
      return builtInProxyNames.has(name) || isBlockedSelectableNodeName(name) ? undefined : name;
    }

    if (visited.has(name)) {
      return undefined;
    }
    visited.add(name);

    const current = item.now;
    if (current && current !== name) {
      const resolved = resolveProxyNode(proxies, current, visited);
      if (resolved) {
        return resolved;
      }
    }

    return collectSelectableNodes(proxies, item.all)[0];
  }

  function collectSelectableNodes(proxies: Record<string, MihomoProxyItem>, names: string[]): string[] {
    const nodes: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name) || builtInProxyNames.has(name)) return;
      seen.add(name);

      const item = proxies[name];
      if (item?.all?.length) {
        item.all.forEach(visit);
        return;
      }

      if (!strategyTargetSet.has(name) && !isBlockedSelectableNodeName(name)) {
        nodes.push(name);
      }
    };

    names.forEach(visit);
    return nodes;
  }

  function collectAllSelectableNodes(proxies: Record<string, MihomoProxyItem>, preferredNames: string[]): string[] {
    const nodes: string[] = [];
    const seen = new Set<string>();
    const add = (name: string) => {
      if (seen.has(name) || builtInProxyNames.has(name) || strategyTargetSet.has(name)) return;
      if (isBlockedSelectableNodeName(name)) return;
      const item = proxies[name];
      if (item?.all?.length) return;
      seen.add(name);
      nodes.push(name);
    };

    collectSelectableNodes(proxies, preferredNames).forEach(add);
    for (const item of Object.values(proxies)) {
      if (item.all?.length) {
        collectSelectableNodes(proxies, item.all).forEach(add);
      }
    }
    return nodes;
  }

  function collectProviderNodes(data: MihomoProvidersResponse): MihomoProviderNode[] {
    const nodes: MihomoProviderNode[] = [];
    const seen = new Set<string>();

    for (const [provider, rawProvider] of Object.entries(data.providers ?? {})) {
      if (provider === 'default' || !isRecord(rawProvider) || !Array.isArray(rawProvider.proxies)) {
        continue;
      }

      for (const rawProxy of rawProvider.proxies) {
        if (!isRecord(rawProxy) || typeof rawProxy.name !== 'string') {
          continue;
        }
        const name = rawProxy.name;
        if (seen.has(name) || builtInProxyNames.has(name) || strategyTargetSet.has(name)) {
          continue;
        }
        if (isBlockedSelectableNodeName(name)) {
          continue;
        }
        seen.add(name);
        nodes.push({
          provider,
          name,
          item: {
            type: typeof rawProxy.type === 'string' ? rawProxy.type : undefined,
            now: typeof rawProxy.now === 'string' ? rawProxy.now : undefined,
            all: Array.isArray(rawProxy.all)
              ? rawProxy.all.filter((value): value is string => typeof value === 'string')
              : undefined,
            history: Array.isArray(rawProxy.history)
              ? rawProxy.history.filter((entry): entry is { delay?: number } => isRecord(entry))
              : undefined
          }
        });
      }
    }

    return nodes;
  }

  function resolveSelectionSteps(
    proxies: Record<string, MihomoProxyItem>,
    selector: { name: string; item: MihomoProxyItem },
    name: string
  ): Array<{ group: string; name: string }> | null {
    if (isBlockedSelectableNodeName(name)) {
      return null;
    }

    return resolveSelectionStepsForGroup(proxies, selector.name, name);
  }

  function resolveSelectionStepsForGroup(
    proxies: Record<string, MihomoProxyItem>,
    group: string,
    name: string
  ): Array<{ group: string; name: string }> | null {
    const topLevel = proxies[group]?.all ?? [];
    if (topLevel.includes(name)) {
      return [{ group, name }];
    }

    const path = resolveSelectionPath(proxies, topLevel, name, new Set([group]));
    if (!path) {
      return null;
    }

    const steps: Array<{ group: string; name: string }> = [{ group: path.at(-1) ?? group, name }];
    for (let index = path.length - 2; index >= 0; index -= 1) {
      steps.push({ group: path[index], name: path[index + 1] });
    }
    steps.push({ group, name: path[0] });
    return steps;
  }

  function collectSyncedSelectionSteps(
    proxies: Record<string, MihomoProxyItem>,
    target: string,
    primarySteps: Array<{ group: string; name: string }>
  ): Array<{ group: string; name: string; required: boolean }> {
    const stepsByGroup = new Map<string, { group: string; name: string; required: boolean }>();
    for (const step of primarySteps) {
      stepsByGroup.set(step.group, { ...step, required: true });
    }

    for (const [group, item] of Object.entries(proxies)) {
      if (!item.all?.length || builtInProxyNames.has(group)) {
        continue;
      }

      const steps = resolveSelectionStepsForGroup(proxies, group, target);
      for (const step of steps ?? []) {
        const existing = stepsByGroup.get(step.group);
        if (existing?.required) {
          continue;
        }
        stepsByGroup.set(step.group, { ...step, required: requiredSyncedGroupNames.has(step.group) });
      }
    }

    return [...stepsByGroup.values()];
  }

  function resolveSelectionPath(
    proxies: Record<string, MihomoProxyItem>,
    names: string[],
    target: string,
    visited: Set<string>
  ): string[] | null {
    for (const name of names) {
      const item = proxies[name];
      if (!item?.all?.length || builtInProxyNames.has(name) || visited.has(name)) {
        continue;
      }

      if (item.all.includes(target)) {
        return [name];
      }

      visited.add(name);
      const nested = resolveSelectionPath(proxies, item.all, target, visited);
      visited.delete(name);
      if (nested) {
        return [name, ...nested];
      }
    }

    return null;
  }

  async function waitForSelectedNode(name: string): Promise<void> {
    const deadline = Date.now() + 6000;
    let lastNode = '';

    while (Date.now() < deadline) {
      const data = await readProxies();
      const proxies = data.proxies ?? {};
      lastNode = resolveCurrentNode(proxies, findCurrentSelector(proxies));
      if (lastNode === name) {
        return;
      }
      await sleep(180);
    }

    throw new Error(`mihomo node selection not applied: expected ${name}, got ${lastNode || 'unknown'}`);
  }

  async function waitForSelectorChoice(group: string, name: string): Promise<void> {
    const deadline = Date.now() + 6000;
    let lastChoice = '';

    while (Date.now() < deadline) {
      const data = await readProxies();
      const proxies = data.proxies ?? {};
      lastChoice = proxies[group]?.now ?? '';
      if (lastChoice === name) {
        return;
      }
      await sleep(180);
    }

    throw new Error(`mihomo strategy selection not applied: expected ${name}, got ${lastChoice || 'unknown'}`);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('node testing cancelled');
    }
  }

  function isAbortError(error: unknown, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError');
  }

  function pickFastestUsableNode(nodes: ProxyNode[], avoidNode?: string): ProxyNode | undefined {
    const usable = nodes
      .filter((node) => typeof node.delay === 'number')
      .sort((left, right) => (left.delay ?? Number.MAX_SAFE_INTEGER) - (right.delay ?? Number.MAX_SAFE_INTEGER));
    if (!usable.length) return undefined;

    const candidates = avoidNode ? usable.filter((node) => node.name !== avoidNode) : usable;
    const targetPool = candidates.length ? candidates : usable;
    return targetPool.find((node) => isPreferredJapanNode(node.name)) ?? targetPool[0];
  }

  function isPreferredJapanNode(name: string): boolean {
    return preferredJapanNodePatterns.some((pattern) => pattern.test(name));
  }

  async function applySelectionSteps(steps: Array<{ group: string; name: string }>): Promise<void> {
    for (const step of steps) {
      await request(`/proxies/${encodeURIComponent(step.group)}`, {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: step.name })
      });
    }
  }

  async function requestNodeDelay(name: string, url: string, signal?: AbortSignal): Promise<number | undefined> {
    const response = await request(
      `/proxies/${encodeURIComponent(name)}/delay?timeout=${delayTestTimeoutMs}&url=${encodeURIComponent(url)}`,
      {
        headers: headers(),
        signal
      }
    );
    const data = (await response.json()) as MihomoDelayResponse;
    return normalizeDelay(data.delay);
  }

  async function requestProviderNodeDelay(
    provider: string,
    name: string,
    url: string,
    signal?: AbortSignal
  ): Promise<number | undefined> {
    const response = await request(
      `/providers/proxies/${encodeURIComponent(provider)}/${encodeURIComponent(name)}/healthcheck?timeout=${delayTestTimeoutMs}&url=${encodeURIComponent(url)}`,
      {
        method: 'GET',
        headers: headers(),
        signal
      }
    );
    const data = (await response.json()) as MihomoDelayResponse;
    return normalizeDelay(data.delay);
  }

  async function runOwnedNodeDelay(
    name: string,
    owner: NodeTestOwner,
    signal?: AbortSignal
  ): Promise<{ delay: number | undefined; committed: boolean }> {
    try {
      const provider = nodeProviderCache.get(name);
      const results = await Promise.all(
        delayTestUrls.map(async (url) => {
          try {
            return await requestNodeDelay(name, url, signal);
          } catch (error) {
            if (isAbortError(error, signal)) throw error;
            if (provider) {
              return requestProviderNodeDelay(provider, name, url, signal).catch((providerError) => {
                if (isAbortError(providerError, signal)) throw providerError;
                return undefined;
              });
            }
            return undefined;
          }
        })
      );

      const delays = results.filter((delay): delay is number => typeof delay === 'number');
      const delay = delays.length
        ? Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length)
        : undefined;
      if (!ownsNodeTest(name, owner)) return { delay, committed: false };

      if (typeof delay === 'number') {
        nodeDelayCache.set(name, delay);
        nodeTestStateCache.set(name, 'tested');
      } else {
        nodeDelayCache.delete(name);
        nodeTestStateCache.set(name, 'failed');
      }
      nodeTestOwners.delete(name);
      return { delay, committed: true };
    } catch (error) {
      if (isAbortError(error, signal)) {
        restoreOwnedTestState(name, owner);
      } else if (ownsNodeTest(name, owner)) {
        nodeDelayCache.delete(name);
        nodeTestStateCache.set(name, 'failed');
        nodeTestOwners.delete(name);
      }
      throw error;
    }
  }

  return {
    async listNodes() {
      const [data, providers] = await Promise.all([
        readProxies(),
        readProviders().catch(() => ({ providers: {} }) as MihomoProvidersResponse)
      ]);
      const proxies = data.proxies ?? {};
      const selector = findSelector(proxies)?.item;
      const all = selector?.all ?? [];
      const currentNode = resolveCurrentNode(proxies, findCurrentSelector(proxies));
      const providerNodes = collectProviderNodes(providers);
      const providerItems = new Map(providerNodes.map((node) => [node.name, node.item]));
      nodeProviderCache.clear();
      providerNodes.forEach((node) => nodeProviderCache.set(node.name, node.provider));
      const nodeNames = collectAllSelectableNodes(proxies, all);
      for (const providerNode of providerNodes) {
        if (!nodeNames.includes(providerNode.name)) {
          nodeNames.push(providerNode.name);
        }
      }

      return nodeNames.map((name) => {
        const delay = cachedDelay(name, proxies[name] ?? providerItems.get(name));
        return {
          name,
          delay,
          active: name === currentNode,
          testState: cachedTestState(name)
        };
      });
    },
    async listStrategies() {
      const data = await readProxies();
      const proxies = data.proxies ?? {};
      const selected = findSelector(proxies)?.item.now ?? strategyTargets.auto;

      return (Object.entries(strategyTargets) as Array<[Exclude<StrategyKey, 'manual'>, string]>).map(
        ([key, target]) => ({
          key,
          label: strategyLabels[key],
          target,
          active: selected === target,
          now: proxies[target]?.now,
          delay: latestDelay(proxies[target])
        })
      );
    },
    async getCurrentNode() {
      const data = await readProxies();
      const proxies = data.proxies ?? {};
      return resolveCurrentNode(proxies, findCurrentSelector(proxies));
    },
    async getRuntimeStats(options = {}) {
      const response = await request('/connections', {
        headers: headers()
      });
      const data = (await response.json()) as MihomoConnectionsResponse;
      return {
        activeConnections: data.connections?.length ?? 0,
        uploadTotal: data.uploadTotal ?? 0,
        downloadTotal: data.downloadTotal ?? 0,
        connections: options.includeConnections ? (data.connections ?? []) : undefined
      };
    },
    async selectNode(name: string) {
      const data = await readProxies();
      const selector = findSelector(data.proxies ?? {});
      if (!selector) {
        throw new Error('mihomo selector missing');
      }

      const proxies = data.proxies ?? {};
      const steps = resolveSelectionSteps(proxies, selector, name);
      if (!steps) {
        throw new Error('mihomo node missing');
      }

      for (const step of collectSyncedSelectionSteps(proxies, name, steps)) {
        const task = request(`/proxies/${encodeURIComponent(step.group)}`, {
          method: 'PUT',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ name: step.name })
        });
        if (step.required) {
          await task;
        } else {
          await task.catch(() => undefined);
        }
      }
      await waitForSelectedNode(name);
    },
    async selectBestUsableNodeForStrategy(strategy, options = {}) {
      await this.testAllNodes({ signal: options.signal });
      const bestNode = pickFastestUsableNode(await this.listNodes(), options.avoidNode);
      if (!bestNode) {
        return undefined;
      }

      const data = await readProxies();
      const proxies = data.proxies ?? {};
      const targetGroup = strategyTargets[strategy];
      const strategySteps = resolveSelectionStepsForGroup(proxies, targetGroup, bestNode.name);
      const selector = findSelector(proxies);
      if (!strategySteps || !selector?.item.all?.includes(targetGroup)) {
        await this.selectNode(bestNode.name);
        return bestNode.name;
      }

      await applySelectionSteps(strategySteps);
      await request(`/proxies/${encodeURIComponent(selector.name)}`, {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: targetGroup })
      });
      await waitForSelectedNode(bestNode.name);
      return bestNode.name;
    },
    async selectStrategy(strategy: StrategyKey) {
      if (strategy === 'manual') return;
      const data = await readProxies();
      const selector = findSelector(data.proxies ?? {});
      if (!selector) {
        throw new Error('mihomo selector missing');
      }
      const target = strategyTargets[strategy];
      await request(`/proxies/${encodeURIComponent(selector.name)}`, {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: target })
      });
      await waitForSelectorChoice(selector.name, target);
    },
    async setMode(mode: MihomoMode) {
      await request('/configs', {
        method: 'PATCH',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mode })
      });
    },
    async testNodeDelay(name: string, options = {}) {
      assertNotAborted(options.signal);
      if (isBlockedSelectableNodeName(name)) {
        nodeTestOwners.delete(name);
        nodeDelayCache.delete(name);
        nodeTestStateCache.set(name, 'failed');
        return undefined;
      }

      const owner = beginNodeTest(name);
      return (await runOwnedNodeDelay(name, owner, options.signal)).delay;
    },
    async testAllNodes(options = {}) {
      const nodes = await this.listNodes();
      const queue = [...nodes];
      const workers = Array.from({ length: Math.min(delayTestConcurrency, queue.length) }, async () => {
        while (queue.length && !options.signal?.aborted) {
          const node = queue.shift();
          if (node) {
            const owner = beginNodeTest(node.name);
            try {
              await options.onNodeTested?.({ ...node, testState: 'testing' });
              const result = await runOwnedNodeDelay(node.name, owner, options.signal);
              if (result.committed) {
                await options.onNodeTested?.({
                  ...node,
                  delay: result.delay,
                  testState: typeof result.delay === 'number' ? 'tested' : 'failed'
                });
              }
            } catch (error) {
              if (isAbortError(error, options.signal)) {
                restoreOwnedTestState(node.name, owner);
                throw error;
              }
              if (ownsNodeTest(node.name, owner)) {
                nodeDelayCache.delete(node.name);
                nodeTestStateCache.set(node.name, 'failed');
                nodeTestOwners.delete(node.name);
              }
            }
          }
        }
      });
      const results = await Promise.allSettled(workers);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      assertNotAborted(options.signal);
    },
    async selectBestUsableNode(options = {}) {
      await this.testAllNodes({ signal: options.signal });
      const bestNode = pickFastestUsableNode(await this.listNodes(), options.avoidNode);
      if (!bestNode) {
        return undefined;
      }

      await this.selectNode(bestNode.name);
      return bestNode.name;
    },
    async closeConnections() {
      await request('/connections', {
        method: 'DELETE',
        headers: headers()
      });
    },
    async flushDnsCache() {
      await request('/cache/dns/flush', {
        method: 'POST',
        headers: headers()
      });
    },
    async updateProvider(options = {}) {
      assertNotAborted(options.signal);
      let providerNames = [providerName];
      try {
        const response = await request('/providers/proxies', {
          headers: headers(),
          signal: options.signal
        });
        const data = (await response.json()) as MihomoProvidersResponse;
        const names = Object.keys(data.providers ?? {}).filter((name) => name !== 'default');
        if (names.length > 0) {
          providerNames = names;
        }
      } catch (_error) {
        assertNotAborted(options.signal);
        providerNames = [providerName];
      }

      nodeDelayCache.clear();
      nodeTestStateCache.clear();
      nodeTestOwners.clear();
      nodeProviderCache.clear();
      await Promise.all(
        providerNames.map((name) =>
          request(`/providers/proxies/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: headers(),
            signal: options.signal
          })
        )
      );
    }
  };
}
