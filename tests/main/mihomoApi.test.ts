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
    let selected = '自动选择';
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/proxies')) {
        return Response.json({
          proxies: {
            节点选择: {
              type: 'Selector',
              now: selected,
              all: ['自动选择', '香港 01', '日本 01']
            },
            自动选择: { history: [{ delay: 92 }] },
            '香港 01': { history: [{ delay: 120 }] },
            '日本 01': { history: [{ delay: 98 }] }
          }
        });
      }
      selected = JSON.parse(String(init?.body ?? '{}')).name ?? selected;
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.selectNode('日本 01');

    expect(fetcher).toHaveBeenCalledWith(
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
    let mainNow = 'Auto';
    let autoNow = 'node-a';
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: mainNow,
              all: ['Auto', 'DIRECT']
            },
            Auto: {
              type: 'URLTest',
              now: autoNow,
              all: ['node-a', 'node-b']
            },
            'node-a': {},
            'node-b': {}
          }
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(url).endsWith('/proxies/Auto')) autoNow = body.name;
      if (String(url).endsWith('/proxies/Main')) mainNow = body.name;
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.selectNode('node-b');

    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/proxies/Auto', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'node-b' })
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/proxies/Main', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Auto' })
    });
  });

  it('moves the top selector away from DIRECT when selecting a nested node', async () => {
    let mainNow = 'DIRECT';
    let autoNow = 'node-a';
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: mainNow,
              all: ['Auto', 'DIRECT']
            },
            Auto: {
              type: 'URLTest',
              now: autoNow,
              all: ['node-a', 'node-b']
            },
            'node-a': {},
            'node-b': {}
          }
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(url).endsWith('/proxies/Auto')) autoNow = body.name;
      if (String(url).endsWith('/proxies/Main')) mainNow = body.name;
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.getCurrentNode()).resolves.toBe('DIRECT');
    await api.selectNode('node-b');

    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/proxies/Auto', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'node-b' })
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/proxies/Main', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Auto' })
    });
  });

  it('selects a node through multi-level airport groups in stable top-level order', async () => {
    let mainNow = 'DIRECT';
    let regionNow = 'Auto JP';
    let autoNow = 'node-a';
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: mainNow,
              all: ['Region JP', 'Region US', 'DIRECT']
            },
            'Region JP': {
              type: 'Selector',
              now: regionNow,
              all: ['Auto JP', 'node-c']
            },
            'Region US': {
              type: 'Selector',
              now: 'node-b',
              all: ['node-b']
            },
            'Auto JP': {
              type: 'URLTest',
              now: autoNow,
              all: ['node-a', 'node-target']
            },
            'node-a': {},
            'node-b': {},
            'node-c': {},
            'node-target': {}
          }
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(url).endsWith('/proxies/Auto%20JP')) autoNow = body.name;
      if (String(url).endsWith('/proxies/Region%20JP')) regionNow = body.name;
      if (String(url).endsWith('/proxies/Main')) mainNow = body.name;
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.selectNode('node-target');

    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/proxies/Auto%20JP', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'node-target' })
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/proxies/Region%20JP', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Auto JP' })
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/proxies/Main', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Region JP' })
    });
  });

  it('syncs subscription policy groups when selecting a node', async () => {
    let autoNow = 'node-hk';
    let fallbackNow = 'node-hk';
    let meslNow = 'Fallback';
    let finalNow = 'MESL';
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Auto: {
              type: 'URLTest',
              now: autoNow,
              all: ['node-hk', 'node-tw']
            },
            Fallback: {
              type: 'Fallback',
              now: fallbackNow,
              all: ['node-hk', 'node-tw']
            },
            MESL: {
              type: 'Selector',
              now: meslNow,
              all: ['Fallback', 'Auto', 'node-hk', 'node-tw']
            },
            Final: {
              type: 'Selector',
              now: finalNow,
              all: ['MESL', 'Fallback', 'Auto', 'node-hk', 'node-tw']
            },
            'node-hk': {},
            'node-tw': {}
          }
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith('/proxies/Auto')) autoNow = body.name;
      if (path.endsWith('/proxies/Fallback')) fallbackNow = body.name;
      if (path.endsWith('/proxies/MESL')) meslNow = body.name;
      if (path.endsWith('/proxies/Final')) finalNow = body.name;
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.selectNode('node-tw');

    expect(autoNow).toBe('node-tw');
    expect(fallbackNow).toBe('node-tw');
    expect(meslNow).toBe('node-tw');
    expect(finalNow).toBe('node-tw');
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
