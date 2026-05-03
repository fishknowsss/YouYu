import type { MihomoMode, ProxyNode, RuntimeStats, StrategyGroup, StrategyKey } from '../../shared/ipc';
import { strategyLabels, strategyTargets } from './config';

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

export type MihomoApiClient = {
  listNodes: () => Promise<ProxyNode[]>;
  listStrategies: () => Promise<StrategyGroup[]>;
  getCurrentNode: () => Promise<string>;
  getRuntimeStats: () => Promise<RuntimeStats>;
  selectNode: (name: string) => Promise<void>;
  selectStrategy: (strategy: StrategyKey) => Promise<void>;
  setMode: (mode: MihomoMode) => Promise<void>;
  testNodeDelay: (name: string) => Promise<number | undefined>;
  testAllNodes: () => Promise<void>;
  closeConnections: () => Promise<void>;
  updateProvider: () => Promise<void>;
};

const selectorName = '节点选择';
const providerName = 'airport';
const delayTestUrl = 'https://www.gstatic.com/generate_204';
const builtInProxyNames = new Set(['COMPATIBLE', 'DIRECT', 'PASS', 'REJECT', 'REJECT-DROP']);
const noticeNodeKeywords = ['失去支持', '更新你的代理客户端', '官网公告', '代理客户端'];
const strategyTargetSet = new Set<string>([...Object.values(strategyTargets), ...builtInProxyNames]);

type MihomoConnectionsResponse = {
  uploadTotal?: number;
  downloadTotal?: number;
  connections?: unknown[];
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
}): MihomoApiClient {
  const fetcher = options.fetcher ?? fetch;
  const controllerUrl = `http://127.0.0.1:${options.controllerPort ?? 9090}`;

  function headers(extra?: Record<string, string>) {
    return {
      Authorization: `Bearer ${options.secret}`,
      ...extra
    };
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetcher(`${controllerUrl}${path}`, init);
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

  function findSelector(proxies: Record<string, MihomoProxyItem>): { name: string; item: MihomoProxyItem } | null {
    const preferred = proxies[selectorName];
    if (preferred?.all?.length) {
      return { name: selectorName, item: preferred };
    }

    const selector = Object.entries(proxies).find(([_name, item]) => {
      return item.all?.length && item.all.some((name) => name !== 'DIRECT' && proxies[name]);
    });

    return selector ? { name: selector[0], item: selector[1] } : null;
  }

  function latestDelay(item: MihomoProxyItem | undefined): number | undefined {
    const delay = item?.history?.findLast((entry) => typeof entry.delay === 'number')?.delay;
    return typeof delay === 'number' && delay > 0 ? delay : undefined;
  }

  function resolveCurrentNode(proxies: Record<string, MihomoProxyItem>, selector: MihomoProxyItem | undefined) {
    const current = selector?.now ?? strategyTargets.auto;
    const nestedCurrent = proxies[current]?.now;
    const resolved = nestedCurrent && nestedCurrent !== current ? nestedCurrent : current;
    if (!builtInProxyNames.has(resolved)) {
      return resolved;
    }

    return collectSelectableNodes(proxies, selector?.all ?? [])[0] ?? resolved;
  }

  function collectSelectableNodes(proxies: Record<string, MihomoProxyItem>, names: string[]): string[] {
    const nodes: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name) || builtInProxyNames.has(name) || isNoticeNodeName(name)) return;
      seen.add(name);

      const item = proxies[name];
      if (item?.all?.length) {
        item.all.forEach(visit);
        return;
      }

      if (!strategyTargetSet.has(name)) {
        nodes.push(name);
      }
    };

    names.forEach(visit);
    return nodes;
  }

  function isNoticeNodeName(name: string): boolean {
    return noticeNodeKeywords.some((keyword) => name.includes(keyword));
  }

  function inferStrategy(current: string): StrategyKey {
    const found = Object.entries(strategyTargets).find(([_key, target]) => target === current);
    return found ? (found[0] as StrategyKey) : 'manual';
  }

  return {
    async listNodes() {
      const data = await readProxies();
      const proxies = data.proxies ?? {};
      const selector = findSelector(proxies)?.item;
      const all = selector?.all ?? [];
      const selected = selector?.now ?? strategyTargets.auto;
      const currentNode = resolveCurrentNode(proxies, selector);

      return collectSelectableNodes(proxies, all).map((name) => ({
        name,
        delay: latestDelay(proxies[name]),
        active: name === selected || name === currentNode
      }));
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
      return resolveCurrentNode(proxies, findSelector(proxies)?.item);
    },
    async getRuntimeStats() {
      const response = await request('/connections', {
        headers: headers()
      });
      const data = (await response.json()) as MihomoConnectionsResponse;
      return {
        activeConnections: data.connections?.length ?? 0,
        uploadTotal: data.uploadTotal ?? 0,
        downloadTotal: data.downloadTotal ?? 0
      };
    },
    async selectNode(name: string) {
      const data = await readProxies();
      const selector = findSelector(data.proxies ?? {});
      if (!selector) {
        throw new Error('mihomo selector missing');
      }

      const directSelector = selector.item.all?.includes(name)
        ? selector.name
        : Object.entries(data.proxies ?? {}).find(([_groupName, item]) => item.all?.includes(name))?.[0];
      if (!directSelector) {
        throw new Error('mihomo node missing');
      }

      await request(`/proxies/${encodeURIComponent(directSelector)}`, {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name })
      });
    },
    async selectStrategy(strategy: StrategyKey) {
      if (strategy === 'manual') return;
      await this.selectNode(strategyTargets[strategy]);
    },
    async setMode(mode: MihomoMode) {
      await request('/configs', {
        method: 'PATCH',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mode })
      });
    },
    async testNodeDelay(name: string) {
      const response = await request(
        `/proxies/${encodeURIComponent(name)}/delay?timeout=5000&url=${encodeURIComponent(delayTestUrl)}`,
        {
          headers: headers()
        }
      );
      const data = (await response.json()) as MihomoDelayResponse;
      return data.delay;
    },
    async testAllNodes() {
      const nodes = await this.listNodes();
      const queue = [...nodes];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const node = queue.shift();
          if (node) {
            await this.testNodeDelay(node.name).catch(() => undefined);
          }
        }
      });
      await Promise.all(workers);
    },
    async closeConnections() {
      await request('/connections', {
        method: 'DELETE',
        headers: headers()
      });
    },
    async updateProvider() {
      let providerNames = [providerName];
      try {
        const response = await request('/providers/proxies', {
          headers: headers()
        });
        const data = (await response.json()) as MihomoProvidersResponse;
        const names = Object.keys(data.providers ?? {}).filter((name) => name !== 'default');
        if (names.length > 0) {
          providerNames = names;
        }
      } catch {
        providerNames = [providerName];
      }

      await Promise.all(
        providerNames.map((name) =>
          request(`/providers/proxies/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: headers()
          })
        )
      );
    }
  };
}
