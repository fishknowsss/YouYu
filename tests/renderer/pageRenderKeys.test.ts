import { describe, expect, it } from 'vitest';
import { createDevYouYuApi } from '../../src/renderer/devApi';
import { getNodeSelectRenderKey } from '../../src/renderer/pages/NodeSelect';
import { getSettingsRenderKey } from '../../src/renderer/pages/Settings';

describe('renderer page render keys', () => {
  it('ignores traffic-only snapshots on the node page but tracks node-visible state', async () => {
    const snapshot = await createDevYouYuApi().getSnapshot();
    const baseKey = getNodeSelectRenderKey(snapshot);

    expect(
      getNodeSelectRenderKey({
        ...snapshot,
        traffic: { ...snapshot.traffic, totalDownload: snapshot.traffic.totalDownload + 1024 },
        runtime: { ...snapshot.runtime, activeConnections: snapshot.runtime.activeConnections + 1 }
      })
    ).toBe(baseKey);
    expect(getNodeSelectRenderKey({ ...snapshot, currentNode: '另一个节点' })).not.toBe(baseKey);
    expect(
      getNodeSelectRenderKey({
        ...snapshot,
        nodes: [...snapshot.nodes, { name: '新增节点', delay: 80 }]
      })
    ).not.toBe(baseKey);
  });

  it('ignores traffic-only snapshots on settings but tracks settings, diagnostics and updates', async () => {
    const snapshot = await createDevYouYuApi().getSnapshot();
    const baseKey = getSettingsRenderKey(snapshot);

    expect(
      getSettingsRenderKey({
        ...snapshot,
        traffic: { ...snapshot.traffic, totalUpload: snapshot.traffic.totalUpload + 1024 },
        runtime: { ...snapshot.runtime, uploadTotal: snapshot.runtime.uploadTotal + 1024 }
      })
    ).toBe(baseKey);
    expect(
      getSettingsRenderKey({
        ...snapshot,
        features: { ...snapshot.features, tunEnabled: !snapshot.features.tunEnabled }
      })
    ).not.toBe(baseKey);
    expect(
      getSettingsRenderKey({
        ...snapshot,
        update: { ...snapshot.update, status: 'checking' }
      })
    ).not.toBe(baseKey);
    expect(
      getSettingsRenderKey({
        ...snapshot,
        trafficIdentity: {
          userId: 'user-1',
          deviceId: 'device-1',
          name: '测试用户',
          registeredAt: '2026-08-11T00:00:00.000Z'
        }
      })
    ).not.toBe(baseKey);
  });
});
