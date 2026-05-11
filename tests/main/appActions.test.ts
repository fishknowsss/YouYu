import { describe, expect, it, vi } from 'vitest';
import { saveSubscriptionSettings, updateSubscriptionNodes } from '../../src/main/appActions';
import type { AppSnapshot } from '../../src/shared/ipc';
import type { AppSettings } from '../../src/main/storage/settings';

function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    status: 'running',
    currentNode: '自动选择',
    nodes: [{ name: '自动选择', active: true }],
    strategies: [{ key: 'auto', label: '自动', target: '自动选择', active: true }],
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'smart',
    features: {
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled: true,
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
      reportStatus: 'idle'
    },
    subscriptionUrl: 'https://example.com/sub',
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
    controllerSecret: 'secret',
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'smart',
    selectedNode: '',
    systemProxyEnabled: true,
    dnsEnhanced: true,
    snifferEnabled: true,
    tunEnabled: true,
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
});
