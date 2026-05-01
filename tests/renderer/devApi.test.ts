import { describe, expect, it } from 'vitest';
import { createDevYouYuApi } from '../../src/renderer/devApi';

describe('createDevYouYuApi', () => {
  it('previews the app flow in a browser without Electron preload', async () => {
    const api = createDevYouYuApi();

    expect(await api.getSnapshot()).toMatchObject({
      status: 'stopped',
      currentNode: '自动选择',
      subscriptionUrl: ''
    });

    await api.saveSettings({ subscriptionUrl: 'https://example.com/sub' });
    const running = await api.start();

    expect(running.status).toBe('running');
    expect(running.subscriptionUrl).toBe('https://example.com/sub');
    expect(running.nodes.length).toBeGreaterThan(0);

    const selected = await api.selectNode('日本 01');

    expect(selected.currentNode).toBe('日本 01');
    expect(selected.nodes.find((node) => node.name === '日本 01')?.active).toBe(true);
  });

  it('starts the preview flow when updating nodes from a saved subscription', async () => {
    const api = createDevYouYuApi();

    await api.saveSettings({ subscriptionUrl: ' https://example.com/sub ' });
    const updated = await api.updateSubscription();

    expect(updated.status).toBe('running');
    expect(updated.subscriptionUrl).toBe('https://example.com/sub');
    expect(updated.nodes.length).toBeGreaterThan(0);
  });

  it('requires a subscription before starting or updating nodes', async () => {
    const api = createDevYouYuApi();

    await expect(api.start()).rejects.toThrow('missing subscription url');
    await expect(api.updateSubscription()).rejects.toThrow('missing subscription url');
  });
});
