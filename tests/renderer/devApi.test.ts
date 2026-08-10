import { describe, expect, it } from 'vitest';
import { createDevYouYuApi } from '../../src/renderer/devApi';

describe('createDevYouYuApi', () => {
  it('previews the app flow in a browser without Electron preload', async () => {
    const api = createDevYouYuApi();

    expect(await api.getSnapshot()).toMatchObject({
      status: 'stopped',
      currentNode: '自动选择',
      subscriptionUrl: '',
      ruleProfile: 'ruleset',
      features: {
        dnsEnhanced: true,
        tunEnabled: false,
        strictRouteEnabled: true,
        subscriptionRefreshIntervalHours: 12
      }
    });

    await api.registerTrafficIdentity({ name: '测试', passphrase: 'pass' });
    await api.saveSettings({ subscriptionUrl: 'https://example.com/sub' });
    const running = await api.start();

    expect(running.status).toBe('running');
    expect(running.subscriptionUrl).toBe('https://example.com/sub');
    expect(running.nodes.length).toBeGreaterThan(0);

    const selected = await api.selectNode('日本 01');

    expect(selected.currentNode).toBe('日本 01');
    expect(selected.nodes.find((node) => node.name === '日本 01')?.active).toBe(true);
    const connectivity = await api.testAllConnectivity();
    expect(connectivity).toHaveLength(15);
    expect(connectivity.map((result) => result.key)).not.toContain('github');
    await expect(api.cancelOperation('dev-operation')).resolves.toBe(false);
  });

  it('starts the preview flow when updating nodes from a saved subscription', async () => {
    const api = createDevYouYuApi();

    await api.registerTrafficIdentity({ name: '测试', passphrase: 'pass' });
    await api.saveSettings({ subscriptionUrl: ' https://example.com/sub ' });
    const updated = await api.updateSubscription();

    expect(updated.status).toBe('running');
    expect(updated.subscriptionUrl).toBe('https://example.com/sub');
    expect(updated.nodes.length).toBeGreaterThan(0);
  });

  it('requires a subscription before starting or updating nodes', async () => {
    const api = createDevYouYuApi();

    await api.registerTrafficIdentity({ name: '测试', passphrase: 'pass' });

    await expect(api.start()).rejects.toThrow('missing subscription url');
    await expect(api.updateSubscription()).rejects.toThrow('missing subscription url');
  });

  it('requires registration before starting or updating nodes', async () => {
    const api = createDevYouYuApi();

    await api.saveSettings({ subscriptionUrl: 'https://example.com/sub' });

    await expect(api.start()).rejects.toThrow('traffic identity required');
    await expect(api.updateSubscription()).rejects.toThrow('traffic identity required');
  });

  it('provides a safe and repeatable README screenshot preset', async () => {
    const api = createDevYouYuApi({ preset: 'readme' });
    const snapshot = await api.getSnapshot();
    const connectivity = await api.testAllConnectivity();

    expect(snapshot).toMatchObject({
      status: 'running',
      currentNode: '日本 01',
      subscriptionUrl: 'https://example.com/sub/demo-profile',
      trafficIdentity: { name: '演示用户' }
    });
    expect(connectivity).toHaveLength(15);
    for (const result of connectivity) {
      expect(result.ip).toMatch(/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/);
      expect(result.region).toBe('演示区域');
      expect(result.chains).toEqual(['DEMO', '日本 01']);
    }

    const installing = await createDevYouYuApi({ preset: 'readme', updateStatus: 'installing' }).getSnapshot();
    expect(installing.update).toMatchObject({
      status: 'installing',
      message: '已开始自动安装，无需操作'
    });

    const rerouting = await createDevYouYuApi({ preset: 'readme', updateStatus: 'rerouting' }).getSnapshot();
    expect(rerouting.update).toMatchObject({
      status: 'downloading',
      percent: 18,
      message: '线路不稳定，已自动切换重试'
    });

    const notice = await createDevYouYuApi({ preset: 'readme', noticeTone: 'warning' }).getSnapshot();
    expect(notice.userNotice).toMatchObject({
      revision: 1,
      tone: 'warning'
    });
    expect(Date.parse(notice.userNotice?.expiresAt ?? '')).toBeGreaterThan(Date.now());
  });
});
