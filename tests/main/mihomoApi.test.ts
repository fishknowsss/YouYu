import { describe, expect, it, vi } from 'vitest';
import { createMihomoApiClient } from '../../src/main/mihomo/api';

describe('createMihomoApiClient', () => {
  it('reads nodes from the real mihomo proxies response', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        proxies: {
          节点选择: {
            type: 'Selector',
            now: '香港 01',
            all: ['自动选择', '香港 01', '日本 01']
          },
          自动选择: { history: [{ delay: 92 }] },
          '香港 01': { history: [{ delay: 120 }] },
          '日本 01': { history: [{ delay: 98 }] }
        }
      })
    );
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    const nodes = await api.listNodes();

    expect(nodes).toEqual([
      { name: '香港 01', delay: 120, active: true },
      { name: '日本 01', delay: 98, active: false }
    ]);
  });

  it('selects a node through the 节点选择 group', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/proxies')) {
        return Response.json({
          proxies: {
            节点选择: {
              type: 'Selector',
              now: '自动选择',
              all: ['自动选择', '香港 01', '日本 01']
            },
            自动选择: { history: [{ delay: 92 }] },
            '香港 01': { history: [{ delay: 120 }] },
            '日本 01': { history: [{ delay: 98 }] }
          }
        });
      }
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.selectNode('日本 01');

    expect(fetcher).toHaveBeenLastCalledWith(
      'http://127.0.0.1:9090/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: '日本 01' })
      }
    );
  });

  it('reads nodes from nested strategy groups', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        proxies: {
          Main: {
            type: 'Selector',
            now: 'Auto',
            all: ['Auto', 'Fallback', 'DIRECT']
          },
          Auto: {
            type: 'URLTest',
            now: 'node-a',
            all: ['node-a', 'node-b'],
            history: [{ delay: 91 }]
          },
          Fallback: {
            type: 'Fallback',
            now: 'node-b',
            all: ['node-b']
          },
          'node-a': { history: [{ delay: 120 }] },
          'node-b': { history: [{ delay: 98 }] }
        }
      })
    );
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    const nodes = await api.listNodes();

    expect(nodes).toEqual([
      { name: 'node-a', delay: 120, active: true },
      { name: 'node-b', delay: 98, active: false }
    ]);
  });

  it('does not expose COMPATIBLE as a selectable node', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        proxies: {
          Main: {
            type: 'Selector',
            now: 'Auto',
            all: ['Auto', 'COMPATIBLE', 'DIRECT']
          },
          Auto: {
            type: 'URLTest',
            now: 'COMPATIBLE',
            all: ['COMPATIBLE', 'node-a']
          },
          'node-a': { history: [{ delay: 120 }] }
        }
      })
    );
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.getCurrentNode()).resolves.toBe('node-a');
    await expect(api.listNodes()).resolves.toEqual([{ name: 'node-a', delay: 120, active: true }]);
  });

  it('treats zero delay as unknown instead of a working 0ms node', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        proxies: {
          Main: {
            type: 'Selector',
            now: 'node-a',
            all: ['node-a']
          },
          'node-a': { history: [{ delay: 0 }] }
        }
      })
    );
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.listNodes()).resolves.toEqual([{ name: 'node-a', delay: undefined, active: true }]);
  });

  it('selects a node through the nested group that contains it', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: 'Auto',
              all: ['Auto', 'DIRECT']
            },
            Auto: {
              type: 'URLTest',
              now: 'node-a',
              all: ['node-a', 'node-b']
            },
            'node-a': {},
            'node-b': {}
          }
        });
      }
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.selectNode('node-b');

    expect(fetcher).toHaveBeenLastCalledWith('http://127.0.0.1:9090/proxies/Auto', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'node-b' })
    });
  });

  it('tests node delay through the mihomo delay endpoint', async () => {
    let requestedUrl = '';
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return Response.json({ delay: 87 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.testNodeDelay('香港 01')).resolves.toBe(87);
    expect(requestedUrl).toContain('/proxies/%E9%A6%99%E6%B8%AF%2001/delay');
  });

  it('updates every proxy provider reported by mihomo', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/providers/proxies')) {
        return Response.json({
          providers: {
            airport: {},
            backup: {}
          }
        });
      }
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.updateProvider();

    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/providers/proxies/airport', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret'
      }
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/providers/proxies/backup', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret'
      }
    });
  });
});
