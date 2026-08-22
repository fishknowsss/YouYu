import { describe, expect, it, vi } from 'vitest';
import { createAppSnapshotReader, createDefaultStrategies } from '../../src/main/appSnapshot';
import type { AppSettings } from '../../src/main/storage/settings';
import type { AppSnapshot, CurrentNodeHealth, PersistentTrafficStats, StrategyGroup } from '../../src/shared/ipc';

const settings: AppSettings = {
  settingsVersion: 6,
  subscriptionUrl: 'https://local.example/subscription',
  localSubscriptionUrl: 'https://local.example/subscription',
  remoteSubscriptionUrl: 'https://remote.example/subscription',
  controllerSecret: 'controller-secret-1234',
  mode: 'rule',
  strategy: 'auto',
  ruleProfile: 'ruleset',
  selectedNode: '',
  petWindow: undefined,
  systemProxyEnabled: true,
  dnsEnhanced: true,
  snifferEnabled: true,
  tunEnabled: false,
  strictRouteEnabled: true,
  allowLan: false,
  subscriptionRefreshIntervalHours: 12
};

const fallbackStrategies: StrategyGroup[] = createDefaultStrategies('auto');
const nodeHealth: CurrentNodeHealth = {
  nodeName: '日本 01',
  delayStatus: 'measured',
  delay: 42,
  availability: { status: 'measured', totalCount: 2, availableCount: 2, percent: 100, tone: 'success' }
};
const traffic: PersistentTrafficStats = {
  totalUpload: 10,
  totalDownload: 20,
  todayUpload: 3,
  todayDownload: 4,
  pendingUpload: 0,
  pendingDownload: 0,
  nodeUsage: {},
  reportStatus: 'synced'
};

function createReader(overrides: Record<string, unknown> = {}) {
  const api = {
    listNodes: vi.fn(async () => [{ name: '日本 01', active: true }]),
    listStrategies: vi.fn(async () => fallbackStrategies),
    getRuntimeStats: vi.fn(async () => ({ activeConnections: 1, uploadTotal: 11, downloadTotal: 22 })),
    getCurrentNode: vi.fn(async () => '日本 01')
  };
  const dependencies = {
    readSettings: vi.fn(async () => settings),
    getRuntimeStatus: vi.fn(() => 'running' as const),
    getControllerPort: vi.fn(() => 19090),
    createMihomoApi: vi.fn(() => api),
    readTrafficSnapshot: vi.fn(async () => ({ stats: traffic, identity: undefined })),
    readUserNotice: vi.fn(async () => undefined),
    readRemoteConfigSnapshot: vi.fn(async () => ({
      revision: 'config-7',
      ready: true,
      canEditManagedConfig: false,
      config: {
        version: 7,
        enabled: true,
        configSource: 'global' as const,
        ruleProfile: 'subscription' as const,
        directRules: [],
        proxyRules: [],
        updatedAt: '2026-08-22T01:02:03.000Z'
      }
    })),
    readNodeHealth: vi.fn(async () => nodeHealth),
    readDynamicState: vi.fn(() => ({
      nodeSelectionNotice: { id: 9, message: '已选择日本节点' },
      subscriptionRevision: 12,
      update: {
        currentVersion: '1.7.13',
        buildChannel: 'standard' as const,
        updateChannel: 'latest',
        status: 'idle' as const
      },
      lastError: 'sample error',
      logs: ['first', 'second'],
      logCount: 2,
      logCapacity: 400,
      droppedLogCount: 1
    })),
    classifyDiagnosticIssue: vi.fn(() => 'network' as const),
    ...overrides
  };

  return { reader: createAppSnapshotReader(dependencies), dependencies, api };
}

describe('createAppSnapshotReader', () => {
  it('assembles the existing public snapshot contract from runtime and persistent sources', async () => {
    const { reader, dependencies } = createReader();

    const snapshot = await reader.read();

    expect(snapshot).toMatchObject({
      status: 'running',
      currentNode: '日本 01',
      nodes: [{ name: '日本 01', active: true }],
      strategies: fallbackStrategies,
      mode: 'rule',
      strategy: 'auto',
      ruleProfile: 'subscription',
      configSource: 'global',
      canEditManagedConfig: false,
      remoteConfigReady: true,
      configUpdatedAt: '2026-08-22T01:02:03.000Z',
      features: {
        systemProxyEnabled: true,
        dnsEnhanced: true,
        snifferEnabled: true,
        tunEnabled: false,
        strictRouteEnabled: true,
        allowLan: false,
        subscriptionRefreshIntervalHours: 12
      },
      runtime: { activeConnections: 1, uploadTotal: 11, downloadTotal: 22 },
      traffic,
      nodeHealth,
      nodeSelectionNotice: { id: 9, message: '已选择日本节点' },
      subscriptionUrl: 'https://local.example/subscription',
      remoteSubscriptionUrl: 'https://remote.example/subscription',
      subscriptionRevision: 12,
      update: { currentVersion: '1.7.13', buildChannel: 'standard', updateChannel: 'latest', status: 'idle' },
      diagnostics: {
        lastError: 'sample error',
        logs: ['first', 'second'],
        logCount: 2,
        logCapacity: 400,
        droppedLogCount: 1,
        issueKind: 'network'
      }
    } satisfies Partial<AppSnapshot>);
    expect(dependencies.createMihomoApi).toHaveBeenCalledWith({
      secret: 'controller-secret-1234',
      controllerPort: 19090
    });
    expect(dependencies.readNodeHealth).toHaveBeenCalledWith('日本 01', true, settings);
  });

  it('preserves stopped and per-source failure fallbacks without changing snapshot fields', async () => {
    const { reader, api } = createReader({
      getRuntimeStatus: vi.fn(() => 'stopped' as const)
    });

    const stopped = await reader.read();

    expect(stopped.status).toBe('stopped');
    expect(stopped.currentNode).toBe('自动选择');
    expect(stopped.nodes).toEqual([]);
    expect(stopped.strategies).toEqual(fallbackStrategies);
    expect(stopped.runtime).toEqual({ activeConnections: 0, uploadTotal: 0, downloadTotal: 0 });
    expect(api.listNodes).not.toHaveBeenCalled();

    const running = createReader({
      createMihomoApi: vi.fn(() => ({
        listNodes: vi.fn(async () => {
          throw new Error('nodes unavailable');
        }),
        listStrategies: vi.fn(async () => {
          throw new Error('strategies unavailable');
        }),
        getRuntimeStats: vi.fn(async () => {
          throw new Error('stats unavailable');
        }),
        getCurrentNode: vi.fn(async () => {
          throw new Error('selection unavailable');
        })
      }))
    });

    await expect(running.reader.read()).resolves.toMatchObject({
      status: 'running',
      currentNode: '自动选择',
      nodes: [],
      strategies: fallbackStrategies,
      runtime: { activeConnections: 0, uploadTotal: 0, downloadTotal: 0 }
    });
  });
});
