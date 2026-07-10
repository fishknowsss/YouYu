import { beforeEach, describe, expect, it } from 'vitest';
import { createDevYouYuApi } from '../../src/renderer/devApi';
import {
  getConnectivityCacheKey,
  getConnectivityCacheKeysForTests,
  resetConnectivityCacheForTests,
  touchConnectivityCacheForTests
} from '../../src/renderer/pages/TestPage';

describe('connectivity test cache context', () => {
  beforeEach(resetConnectivityCacheForTests);
  it('does not share same-name node results across subscriptions or registrations', async () => {
    const snapshot = await createDevYouYuApi().getSnapshot();
    const base = {
      ...snapshot,
      currentNode: '自动选择',
      subscriptionUrl: 'https://example.com/a',
      trafficIdentity: {
        userId: 'user-a',
        deviceId: 'device-a',
        name: '测试',
        registeredAt: '2026-07-11T00:00:00.000Z'
      }
    };

    expect(getConnectivityCacheKey({ ...base, subscriptionUrl: 'https://example.com/b' })).not.toBe(
      getConnectivityCacheKey(base)
    );
    expect(
      getConnectivityCacheKey({
        ...base,
        trafficIdentity: { ...base.trafficIdentity, deviceId: 'device-b' }
      })
    ).not.toBe(getConnectivityCacheKey(base));
  });

  it('invalidates results when routing configuration or node roster changes', async () => {
    const snapshot = await createDevYouYuApi().getSnapshot();
    const baseKey = getConnectivityCacheKey(snapshot);

    expect(
      getConnectivityCacheKey({
        ...snapshot,
        ruleProfile: snapshot.ruleProfile === 'smart' ? 'ruleset' : 'smart'
      })
    ).not.toBe(baseKey);
    expect(getConnectivityCacheKey({ ...snapshot, subscriptionRevision: 1 })).not.toBe(baseKey);
    expect(
      getConnectivityCacheKey({
        ...snapshot,
        nodes: [...snapshot.nodes, { name: '新增节点' }]
      })
    ).not.toBe(baseKey);
    expect(
      getConnectivityCacheKey({
        ...snapshot,
        features: { ...snapshot.features, tunEnabled: !snapshot.features.tunEnabled }
      })
    ).not.toBe(baseKey);
  });

  it('keeps recently read contexts when the LRU reaches its capacity', async () => {
    const snapshot = await createDevYouYuApi().getSnapshot();
    for (let revision = 0; revision < 12; revision += 1) {
      touchConnectivityCacheForTests(getConnectivityCacheKey({ ...snapshot, subscriptionRevision: revision }));
    }
    const firstKey = getConnectivityCacheKey({ ...snapshot, subscriptionRevision: 0 });
    const secondKey = getConnectivityCacheKey({ ...snapshot, subscriptionRevision: 1 });
    touchConnectivityCacheForTests(firstKey);
    touchConnectivityCacheForTests(getConnectivityCacheKey({ ...snapshot, subscriptionRevision: 12 }));

    expect(getConnectivityCacheKeysForTests()).toHaveLength(12);
    expect(getConnectivityCacheKeysForTests()).toContain(firstKey);
    expect(getConnectivityCacheKeysForTests()).not.toContain(secondKey);
  });

  it('keeps the cache stable for traffic counters and node delay refreshes', async () => {
    const snapshot = await createDevYouYuApi().getSnapshot();
    const baseKey = getConnectivityCacheKey(snapshot);

    expect(
      getConnectivityCacheKey({
        ...snapshot,
        runtime: { ...snapshot.runtime, uploadTotal: snapshot.runtime.uploadTotal + 1024 },
        nodes: snapshot.nodes.map((node) => ({ ...node, delay: (node.delay ?? 0) + 10 }))
      })
    ).toBe(baseKey);
  });
});
