import { describe, expect, it, vi } from 'vitest';
import {
  saveSubscriptionSettings,
  testAllMihomoNodes,
  testMihomoNode,
  updateSubscriptionNodes
} from '../../src/main/appActions';
import type { AppSnapshot } from '../../src/shared/ipc';
import type { AppSettings } from '../../src/main/storage/settings';

function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    status: 'running',
    currentNode: '自动选择',
    nodes: [{ name: '自动选择', active: true }],
    nodeHealth: {
      nodeName: '自动选择',
      delayStatus: 'untested',
      availability: {
        status: 'untested',
        totalCount: 10
      }
    },
    strategies: [{ key: 'auto', label: '自动', target: '自动选择', active: true }],
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'smart',
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
    subscriptionUrl: 'https://example.com/sub',
    update: {
      currentVersion: '1.3.0',
      buildChannel: 'standard',
      updateChannel: 'latest',
      status: 'idle'
    },
    diagnostics: {
      logs: []
    },
    ...overrides
  };
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    settingsVersion: 1,
    subscriptionUrl: 'https://example.com/sub',
    localSubscriptionUrl: 'https://example.com/sub',
    controllerSecret: 'secret',
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'smart',
    selectedNode: '',
    systemProxyEnabled: true,
    dnsEnhanced: true,
    snifferEnabled: true,
    tunEnabled: false,
    strictRouteEnabled: true,
    allowLan: false,
    subscriptionRefreshIntervalHours: 12,
    ...overrides
  };
}

function makeMihomoApi(overrides = {}) {
  return {
    updateProvider: vi.fn(async () => undefined),
    setMode: vi.fn(async () => undefined),
    selectStrategy: vi.fn(async () => undefined),
    testNodeDelay: vi.fn(async () => 100),
    testAllNodes: vi.fn(async () => undefined),
    closeConnections: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('app actions', () => {
  it('starts mihomo before updating nodes when the controller is stopped', async () => {
    const lifecycle = {
      getStatus: vi.fn(() => 'stopped' as const),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      repair: vi.fn(async () => undefined)
    };
    const updateProvider = vi.fn(async () => undefined);

    await updateSubscriptionNodes({
      settingsStore: {
        read: async () => makeSettings(),
        update: vi.fn()
      },
      lifecycle,
      createMihomoApi: () => makeMihomoApi({ updateProvider }),
      createSnapshot: async () => makeSnapshot()
    });

    expect(lifecycle.start).toHaveBeenCalledOnce();
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it('repairs and retries when starting for an update fails once', async () => {
    const signal = new AbortController().signal;
    const lifecycle = {
      getStatus: vi.fn(() => 'stopped' as const),
      start: vi.fn().mockRejectedValueOnce(new Error('startup failed')).mockResolvedValueOnce(undefined),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      repair: vi.fn(async () => undefined)
    };

    await updateSubscriptionNodes(
      {
        settingsStore: {
          read: async () => makeSettings(),
          update: vi.fn()
        },
        lifecycle,
        createMihomoApi: () => makeMihomoApi(),
        createSnapshot: async () => makeSnapshot()
      },
      { signal }
    );

    expect(lifecycle.start).toHaveBeenCalledTimes(2);
    expect(lifecycle.repair).toHaveBeenCalledWith(signal);
  });

  it('does not restart after a running provider update is canceled', async () => {
    const controller = new AbortController();
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const updateProvider = vi.fn(async () => {
      controller.abort(new Error('operation canceled'));
      throw controller.signal.reason;
    });

    await expect(
      updateSubscriptionNodes(
        {
          settingsStore: {
            read: async () => makeSettings(),
            update: vi.fn()
          },
          lifecycle: {
            getStatus: () => 'running',
            start,
            stop,
            restart: vi.fn(),
            repair: vi.fn()
          },
          createMihomoApi: () => makeMihomoApi({ updateProvider }),
          createSnapshot: async () => makeSnapshot()
        },
        { signal: controller.signal }
      )
    ).rejects.toThrow('operation canceled');

    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('updates the running provider without restarting when mihomo accepts it', async () => {
    const updateProvider = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);

    await updateSubscriptionNodes({
      settingsStore: {
        read: async () => makeSettings(),
        update: vi.fn()
      },
      lifecycle: {
        getStatus: () => 'running',
        start,
        stop,
        restart: vi.fn(),
        repair: vi.fn()
      },
      createMihomoApi: () => makeMihomoApi({ updateProvider }),
      createSnapshot: async () => makeSnapshot()
    });

    expect(updateProvider).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('restarts mihomo to refresh an inlined subscription when provider update fails', async () => {
    const updateProvider = vi.fn(async () => {
      throw new Error('missing provider');
    });
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);

    await updateSubscriptionNodes({
      settingsStore: {
        read: async () => makeSettings(),
        update: vi.fn()
      },
      lifecycle: {
        getStatus: () => 'running',
        start,
        stop,
        restart: vi.fn(),
        repair: vi.fn()
      },
      createMihomoApi: () => makeMihomoApi({ updateProvider }),
      createSnapshot: async () => makeSnapshot()
    });

    expect(updateProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('fully restarts mihomo after saving settings while running', async () => {
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const update = vi.fn(async () => makeSettings({ subscriptionUrl: 'https://example.com/new' }));

    await saveSubscriptionSettings(
      {
        settingsStore: {
          read: vi.fn(),
          update
        },
        lifecycle: {
          getStatus: () => 'running',
          start,
          stop,
          restart: vi.fn(),
          repair: vi.fn()
        },
        createSnapshot: async () => makeSnapshot({ subscriptionUrl: 'https://example.com/new' })
      },
      ' https://example.com/new '
    );

    expect(update).toHaveBeenCalledWith({ subscriptionUrl: 'https://example.com/new' });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('passes the all-node test cancellation signal to mihomo', async () => {
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    const testAllNodes = vi.fn(async () => undefined);
    const createSnapshot = vi.fn(async () => makeSnapshot());

    await testAllMihomoNodes(
      {
        settingsStore: {
          read: async () => makeSettings(),
          update: vi.fn()
        },
        lifecycle: {
          getStatus: () => 'running',
          start: vi.fn(),
          stop: vi.fn(),
          restart: vi.fn(),
          repair: vi.fn()
        },
        createMihomoApi: () => makeMihomoApi({ testAllNodes }),
        createSnapshot
      },
      { signal, onProgress }
    );

    expect(testAllNodes).toHaveBeenCalledWith({
      signal,
      onNodeTested: expect.any(Function)
    });
    expect(createSnapshot).toHaveBeenCalledOnce();
  });

  it('publishes the measured delay after a single node test', async () => {
    const onDelayTested = vi.fn();
    const testNodeDelay = vi.fn(async () => 86);

    await testMihomoNode(
      {
        settingsStore: {
          read: async () => makeSettings(),
          update: vi.fn()
        },
        lifecycle: {
          getStatus: () => 'running',
          start: vi.fn(),
          stop: vi.fn(),
          restart: vi.fn(),
          repair: vi.fn()
        },
        createMihomoApi: () => makeMihomoApi({ testNodeDelay }),
        createSnapshot: async () => makeSnapshot()
      },
      '日本 01',
      { onDelayTested }
    );

    expect(onDelayTested).toHaveBeenCalledWith('日本 01', 86);
  });

  it('passes every all-node progress result to the node health hook', async () => {
    const testedNode = { name: '日本 01', delay: 88, active: true, testState: 'tested' as const };
    const onNodeTested = vi.fn();
    const testAllNodes = vi.fn(
      async (options: { onNodeTested?: (node: typeof testedNode) => void | Promise<void> }) => {
        await options.onNodeTested?.(testedNode);
      }
    );

    await testAllMihomoNodes(
      {
        settingsStore: {
          read: async () => makeSettings(),
          update: vi.fn()
        },
        lifecycle: {
          getStatus: () => 'running',
          start: vi.fn(),
          stop: vi.fn(),
          restart: vi.fn(),
          repair: vi.fn()
        },
        createMihomoApi: () => makeMihomoApi({ testAllNodes }),
        createSnapshot: async () => makeSnapshot()
      },
      { onNodeTested }
    );

    expect(onNodeTested).toHaveBeenCalledWith(testedNode);
  });
});
