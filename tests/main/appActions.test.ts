import { describe, expect, it, vi } from 'vitest';
import {
  saveSubscriptionSettings,
  testAllMihomoNodes,
  testMihomoNode,
  updateSubscriptionNodes
} from '../../src/main/appActions';
import type { AppSnapshot } from '../../src/shared/ipc';
import type { AppSettings } from '../../src/main/storage/settings';
import type { LifecycleController } from '../../src/main/lifecycle';

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
    ruleProfile: 'ruleset',
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

function makeLifecycle(overrides: Partial<LifecycleController> = {}): LifecycleController {
  return {
    getStatus: () => 'running',
    suspendStarts: vi.fn(),
    resumeStarts: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    repair: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('app actions', () => {
  it('starts mihomo before updating nodes when the controller is stopped', async () => {
    const lifecycle = makeLifecycle({ getStatus: vi.fn(() => 'stopped' as const) });
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

  it('fails directly without repairing or retrying an unknown startup failure', async () => {
    const signal = new AbortController().signal;
    const lifecycle = makeLifecycle({
      getStatus: vi.fn(() => 'stopped' as const),
      start: vi.fn().mockRejectedValueOnce(new Error('startup failed')).mockResolvedValueOnce(undefined)
    });

    await expect(
      updateSubscriptionNodes(
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
      )
    ).rejects.toThrow('startup failed');

    expect(lifecycle.start).toHaveBeenCalledOnce();
    expect(lifecycle.repair).not.toHaveBeenCalled();
  });

  it('retries a transient core startup failure without running a full repair', async () => {
    const lifecycle = makeLifecycle({
      getStatus: vi.fn(() => 'stopped' as const),
      start: vi
        .fn()
        .mockRejectedValueOnce(new Error('mihomo controller not ready on 127.0.0.1:9090'))
        .mockResolvedValueOnce(undefined)
    });

    await updateSubscriptionNodes({
      settingsStore: {
        read: async () => makeSettings(),
        update: vi.fn()
      },
      lifecycle,
      createMihomoApi: () => makeMihomoApi(),
      createSnapshot: async () => makeSnapshot()
    });

    expect(lifecycle.start).toHaveBeenCalledTimes(2);
    expect(lifecycle.repair).not.toHaveBeenCalled();
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
          lifecycle: makeLifecycle({ start, stop }),
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
      lifecycle: makeLifecycle({ start, stop }),
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
      lifecycle: makeLifecycle({ start, stop }),
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
        lifecycle: makeLifecycle({ start, stop }),
        createSnapshot: async () => makeSnapshot({ subscriptionUrl: 'https://example.com/new' })
      },
      ' https://example.com/new '
    );

    expect(update).toHaveBeenCalledWith({ subscriptionUrl: 'https://example.com/new' });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('publishes changed managed settings before persisting and restarting the local runtime', async () => {
    const order: string[] = [];
    const updateRemote = vi.fn(async () => {
      order.push('remote-update');
      return {
        version: 4,
        enabled: true,
        configSource: 'user' as const,
        subscriptionUrl: 'https://example.com/alice',
        ruleProfile: 'subscription' as const,
        directRules: [],
        proxyRules: []
      };
    });
    const updateLocal = vi.fn(async () => {
      order.push('local-update');
      return makeSettings({
        subscriptionUrl: 'https://example.com/alice',
        ruleProfile: 'subscription'
      });
    });
    const restart = vi.fn(async () => {
      order.push('restart');
    });

    await saveSubscriptionSettings(
      {
        settingsStore: { read: vi.fn(), update: updateLocal },
        lifecycle: makeLifecycle(),
        runtime: { start: vi.fn(async () => undefined), restart },
        remoteConfig: {
          read: async () => ({
            version: 3,
            enabled: true,
            configSource: 'global',
            subscriptionUrl: 'https://example.com/global',
            ruleProfile: 'ruleset',
            directRules: [],
            proxyRules: []
          }),
          update: updateRemote,
          apply: async () => {
            order.push('remote-apply');
          }
        },
        createSnapshot: async () => makeSnapshot()
      } as Parameters<typeof saveSubscriptionSettings>[0],
      {
        subscriptionUrl: ' https://example.com/alice ',
        ruleProfile: 'subscription'
      }
    );

    expect(updateRemote).toHaveBeenCalledWith(
      {
        subscriptionUrl: 'https://example.com/alice',
        ruleProfile: 'subscription'
      },
      undefined
    );
    expect(order).toEqual(['remote-update', 'remote-apply', 'local-update', 'restart']);
  });

  it('does not create a user override when only local settings changed', async () => {
    const updateRemote = vi.fn();
    const updateLocal = vi.fn(async () => makeSettings({ tunEnabled: true }));

    await saveSubscriptionSettings(
      {
        settingsStore: { read: vi.fn(), update: updateLocal },
        lifecycle: makeLifecycle({ getStatus: () => 'stopped' }),
        remoteConfig: {
          read: async () => ({
            version: 3,
            enabled: true,
            configSource: 'global',
            subscriptionUrl: 'https://example.com/global',
            ruleProfile: 'ruleset',
            directRules: [],
            proxyRules: []
          }),
          update: updateRemote,
          apply: vi.fn()
        },
        createSnapshot: async () => makeSnapshot()
      },
      {
        subscriptionUrl: 'https://example.com/global',
        ruleProfile: 'ruleset',
        tunEnabled: true
      }
    );

    expect(updateRemote).not.toHaveBeenCalled();
    expect(updateLocal).toHaveBeenCalledOnce();
  });

  it('does not persist a conflicting local managed value when the cloud write fails', async () => {
    const updateLocal = vi.fn();
    await expect(
      saveSubscriptionSettings(
        {
          settingsStore: { read: vi.fn(), update: updateLocal },
          lifecycle: makeLifecycle(),
          remoteConfig: {
            read: async () => ({
              version: 3,
              enabled: true,
              configSource: 'global',
              ruleProfile: 'ruleset',
              directRules: [],
              proxyRules: []
            }),
            update: async () => {
              throw new Error('cloud unavailable');
            },
            apply: vi.fn()
          },
          createSnapshot: async () => makeSnapshot()
        },
        { ruleProfile: 'subscription' }
      )
    ).rejects.toThrow('cloud unavailable');

    expect(updateLocal).not.toHaveBeenCalled();
  });

  it('delegates a running subscription fallback to the intent-aware runtime restart', async () => {
    const updateProvider = vi.fn(async () => {
      throw new Error('missing provider');
    });
    const restart = vi.fn(async () => undefined);
    const lifecycle = makeLifecycle();

    await updateSubscriptionNodes({
      settingsStore: {
        read: async () => makeSettings(),
        update: vi.fn()
      },
      lifecycle,
      runtime: { start: vi.fn(async () => undefined), restart },
      createMihomoApi: () => makeMihomoApi({ updateProvider }),
      createSnapshot: async () => makeSnapshot()
    });

    expect(restart).toHaveBeenCalledOnce();
    expect(lifecycle.stop).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
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
        lifecycle: makeLifecycle(),
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
        lifecycle: makeLifecycle(),
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
        lifecycle: makeLifecycle(),
        createMihomoApi: () => makeMihomoApi({ testAllNodes }),
        createSnapshot: async () => makeSnapshot()
      },
      { onNodeTested }
    );

    expect(onNodeTested).toHaveBeenCalledWith(testedNode);
  });

  it('uses the intent-aware runtime hook before testing a node while stopped', async () => {
    const start = vi.fn(async () => undefined);
    const lifecycle = makeLifecycle({ getStatus: vi.fn(() => 'stopped' as const) });

    await testMihomoNode(
      {
        settingsStore: {
          read: async () => makeSettings(),
          update: vi.fn()
        },
        lifecycle,
        runtime: { start, restart: vi.fn(async () => undefined) },
        createMihomoApi: () => makeMihomoApi(),
        createSnapshot: async () => makeSnapshot()
      },
      'Japan 01'
    );

    expect(start).toHaveBeenCalledOnce();
    expect(lifecycle.start).not.toHaveBeenCalled();
  });
});
