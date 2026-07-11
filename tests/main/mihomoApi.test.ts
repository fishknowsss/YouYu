import { describe, expect, it, vi } from 'vitest';
import { createMihomoApiClient } from '../../src/main/mihomo/api';
import { strategyTargets } from '../../src/main/mihomo/config';

describe('createMihomoApiClient', () => {
  it('times out a stalled controller request', async () => {
    const client = createMihomoApiClient({
      secret: 'secret',
      requestTimeoutMs: 10,
      fetcher: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
    });

    await expect(client.listNodes()).rejects.toMatchObject({ name: 'TimeoutError' });
  });
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
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: '日本 01' })
      })
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

  it('uses the broadest selectable group and includes nodes from other referenced groups', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        proxies: {
          SmallGroup: {
            type: 'Selector',
            now: 'node-a',
            all: ['node-a']
          },
          PROXY: {
            type: 'Selector',
            now: 'node-b',
            all: ['node-a', 'node-b', 'Fallback']
          },
          Fallback: {
            type: 'Fallback',
            now: 'node-c',
            all: ['node-c']
          },
          'node-a': { history: [{ delay: 120 }] },
          'node-b': { history: [{ delay: 98 }] },
          'node-c': { history: [{ delay: 88 }] }
        }
      })
    );
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.listNodes()).resolves.toEqual([
      { name: 'node-a', delay: 120, active: false },
      { name: 'node-b', delay: 98, active: true },
      { name: 'node-c', delay: 88, active: false }
    ]);
  });

  it('includes provider-only nodes and reads their provider delay history', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/providers/proxies')) {
        return Response.json({
          providers: {
            default: {},
            airport: {
              proxies: [
                { name: 'node-a', history: [{ delay: 120 }] },
                { name: 'node-b', history: [{ delay: 88 }] },
                { name: 'remaining traffic 100 GB', history: [{ delay: 1 }] }
              ]
            },
            backup: {
              proxies: [{ name: 'node-c', history: [{ delay: 96 }] }]
            }
          }
        });
      }
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: 'node-a',
              all: ['Auto', 'DIRECT']
            },
            Auto: {
              type: 'URLTest',
              now: 'node-a',
              all: ['node-a']
            },
            'node-a': { history: [{ delay: 120 }] }
          }
        });
      }
      if (path.endsWith('/providers/proxies')) {
        return Response.json({
          providers: {
            default: {},
            airport: {
              proxies: [
                { name: 'node-a', history: [{ delay: 120 }] },
                { name: 'node-b', history: [{ delay: 88 }] },
                { name: '剩余流量：100 GB', history: [{ delay: 1 }] }
              ]
            },
            backup: {
              proxies: [{ name: 'node-c', history: [{ delay: 96 }] }]
            }
          }
        });
      }
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.listNodes()).resolves.toEqual([
      { name: 'node-a', delay: 120, active: true, testState: undefined },
      { name: 'node-b', delay: 88, active: false, testState: undefined },
      { name: 'node-c', delay: 96, active: false, testState: undefined }
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

  it('filters subscription notice nodes from the selectable list and current node fallback', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        proxies: {
          Main: {
            type: 'Selector',
            now: 'Auto',
            all: ['Auto', 'DIRECT']
          },
          Auto: {
            type: 'URLTest',
            now: '剩余流量：796.81 GB',
            all: ['剩余流量：796.81 GB', '距离下次重置剩余：30 天', 'node-a']
          },
          '剩余流量：796.81 GB': { history: [{ delay: 10 }] },
          '距离下次重置剩余：30 天': { history: [{ delay: 10 }] },
          'node-a': { history: [{ delay: 120 }] }
        }
      })
    );
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.getCurrentNode()).resolves.toBe('node-a');
    await expect(api.listNodes()).resolves.toEqual([{ name: 'node-a', delay: 120, active: true }]);
  });

  it('keeps carrier optimized nodes in the selectable list', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        proxies: {
          Main: {
            type: 'Selector',
            now: '中国移动 香港 01',
            all: ['中国移动 香港 01', '中国联通 订阅地址', '中国电信 套餐到期', '电信 日本 02']
          },
          '中国移动 香港 01': { history: [{ delay: 118 }] },
          '中国联通 订阅地址': { history: [{ delay: 10 }] },
          '中国电信 套餐到期': { history: [{ delay: 10 }] },
          '电信 日本 02': { history: [{ delay: 96 }] }
        }
      })
    );
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.listNodes()).resolves.toEqual([
      { name: '中国移动 香港 01', delay: 118, active: true },
      { name: '电信 日本 02', delay: 96, active: false }
    ]);
  });

  it('filters carrier transit notice nodes from selection and delay testing', async () => {
    const noticeNode = '联通移动用中转，电信移动cf';
    const congyuNoticeNode = 'HK 丛雨云';
    const timeoutNoticeNode = '日本 全部超时 01';
    const congyuDomainNode = 'twcongyu.org 🐱';
    const reservedNodes = ['全球直连', '节点选择', '自动选择', '全球拦截'];
    const blockedNodes = [noticeNode, congyuNoticeNode, timeoutNoticeNode, congyuDomainNode, ...reservedNodes];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: congyuDomainNode,
              all: [...blockedNodes, '香港 01']
            },
            [noticeNode]: { history: [{ delay: 9 }] },
            [congyuNoticeNode]: { history: [{ delay: 11 }] },
            [timeoutNoticeNode]: { history: [{ delay: 12 }] },
            [congyuDomainNode]: { history: [{ delay: 13 }] },
            ...Object.fromEntries(reservedNodes.map((name, index) => [name, { history: [{ delay: 20 + index }] }])),
            '香港 01': { history: [{ delay: 88 }] }
          }
        });
      }

      return new Response(null, { status: init?.method === 'PUT' ? 204 : 404 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.getCurrentNode()).resolves.toBe('香港 01');
    await expect(api.listNodes()).resolves.toEqual([{ name: '香港 01', delay: 88, active: true }]);
    for (const node of blockedNodes) {
      await expect(api.testNodeDelay(node)).resolves.toBeUndefined();
      await expect(api.selectNode(node)).rejects.toThrow('mihomo node missing');
    }
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

  it('treats timeout-equivalent delay as unknown instead of a slow working node', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: 'timeout-node',
              all: ['timeout-node']
            },
            'timeout-node': { history: [{ delay: 2000 }] }
          }
        });
      }
      return Response.json({ delay: 2000 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.testNodeDelay('timeout-node')).resolves.toBeUndefined();
    await expect(api.listNodes()).resolves.toEqual([
      { name: 'timeout-node', delay: undefined, active: true, testState: 'failed' }
    ]);
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

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/Auto',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'node-b' })
      })
    );
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/Main',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'Auto' })
      })
    );
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

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/Auto',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'node-b' })
      })
    );
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/Main',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'Auto' })
      })
    );
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

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/Auto%20JP',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'node-target' })
      })
    );
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/Region%20JP',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'Auto JP' })
      })
    );
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/proxies/Main',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'Region JP' })
      })
    );
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

  it('rejects manual selection when the effective final group does not switch', async () => {
    let mainNow = 'node-hk';
    let finalNow = 'node-hk';
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            ProxyMain: {
              type: 'Selector',
              now: mainNow,
              all: ['node-hk', 'node-tw', 'node-extra']
            },
            Final: {
              type: 'Selector',
              now: finalNow,
              all: ['node-hk', 'node-tw']
            },
            'node-hk': {},
            'node-tw': {},
            'node-extra': {}
          }
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith('/proxies/ProxyMain')) mainNow = body.name;
      if (path.endsWith('/proxies/Final')) {
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.selectNode('node-tw')).rejects.toThrow('mihomo api failed');
    expect(mainNow).toBe('node-tw');
    expect(finalNow).toBe('node-hk');
  });

  it('selects strategy groups without waiting for the resolved leaf node to match the strategy name', async () => {
    const autoTarget = strategyTargets.auto;
    let mainNow = 'DIRECT';
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: mainNow,
              all: [autoTarget, 'DIRECT']
            },
            [autoTarget]: {
              type: 'URLTest',
              now: 'node-a',
              all: ['node-a']
            },
            'node-a': {}
          }
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith('/proxies/Main')) mainNow = body.name;
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.selectStrategy('auto');

    expect(mainNow).toBe(autoTarget);
  });

  it('uses the effective rule group for the displayed current node', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        proxies: {
          Auto: {
            type: 'URLTest',
            now: 'node-hk',
            all: ['node-hk', 'node-jp']
          },
          Fallback: {
            type: 'Fallback',
            now: 'node-hk',
            all: ['node-hk', 'node-jp']
          },
          MESL: {
            type: 'Selector',
            now: 'node-jp',
            all: ['Fallback', 'Auto', 'node-hk', 'node-jp']
          },
          Final: {
            type: 'Selector',
            now: 'MESL',
            all: ['MESL', 'Fallback', 'Auto', 'node-hk', 'node-jp']
          },
          GLOBAL: {
            type: 'Selector',
            now: 'node-jp',
            all: ['Fallback', 'Auto', 'node-hk', 'node-jp']
          },
          'node-hk': {},
          'node-jp': {}
        }
      })
    );
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.getCurrentNode()).resolves.toBe('node-jp');
    await expect(api.listNodes()).resolves.toEqual([
      { name: 'node-hk', delay: undefined, active: false },
      { name: 'node-jp', delay: undefined, active: true }
    ]);
  });

  it('tests node delay through independent mihomo delay endpoints', async () => {
    const requestedUrls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      requestedUrls.push(String(url));
      return Response.json({ delay: 87 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.testNodeDelay('香港 01')).resolves.toBe(87);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain('/proxies/%E9%A6%99%E6%B8%AF%2001/delay');
    expect(requestedUrls.every((url) => url.includes('timeout=2000'))).toBe(true);
    expect(decodeURIComponent(requestedUrls[0])).toContain('https://www.gstatic.com/generate_204');
    expect(decodeURIComponent(requestedUrls[1])).toContain('https://cp.cloudflare.com/generate_204');
  });

  it('keeps a node measurable when one independent probe succeeds', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = decodeURIComponent(String(url));
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: 'half-open-node',
              all: ['half-open-node']
            },
            'half-open-node': {}
          }
        });
      }

      return Response.json({ delay: path.includes('cp.cloudflare.com') ? 2000 : 87 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.testNodeDelay('half-open-node')).resolves.toBe(87);
    await expect(api.listNodes()).resolves.toEqual([
      { name: 'half-open-node', delay: 87, active: true, testState: 'tested' }
    ]);
  });

  it('tests all nodes with bounded parallel workers', async () => {
    let active = 0;
    let maxActive = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: 'node-01',
              all: Array.from({ length: 25 }, (_value, index) => `node-${String(index + 1).padStart(2, '0')}`)
            },
            ...Object.fromEntries(
              Array.from({ length: 25 }, (_value, index) => [`node-${String(index + 1).padStart(2, '0')}`, {}])
            )
          }
        });
      }

      if (path.includes('/delay')) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return Response.json({ delay: 80 });
      }

      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.testAllNodes();

    const delayCalls = fetcher.mock.calls.filter(([url]) => String(url).includes('/delay'));
    expect(delayCalls).toHaveLength(50);
    expect(maxActive).toBeGreaterThan(4);
    expect(maxActive).toBeLessThanOrEqual(12);
  });

  it('shows all successful all-node delay results without waiting for mihomo history', async () => {
    const nodeNames = ['cache-node-a', 'cache-node-b', 'cache-node-c'];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: 'cache-node-a',
              all: nodeNames
            },
            ...Object.fromEntries(nodeNames.map((name) => [name, {}]))
          }
        });
      }

      if (path.includes('/delay')) {
        const name = decodeURIComponent(path.match(/\/proxies\/([^/]+)\/delay/)?.[1] ?? '');
        return Response.json({ delay: 80 + nodeNames.indexOf(name) });
      }

      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.testAllNodes();

    await expect(api.listNodes()).resolves.toEqual([
      { name: 'cache-node-a', delay: 80, active: true, testState: 'tested' },
      { name: 'cache-node-b', delay: 81, active: false, testState: 'tested' },
      { name: 'cache-node-c', delay: 82, active: false, testState: 'tested' }
    ]);
  });

  it('tests provider-only nodes through provider healthcheck fallback', async () => {
    const providerHealthchecks: string[] = [];
    const blockedProviderNodes = ['twcongyu.org 🐱', '全球直连', '节点选择', '自动选择', '全球拦截'];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/providers/proxies')) {
        return Response.json({
          providers: {
            airport: {
              proxies: [{ name: 'node-a' }, { name: 'node-b' }, ...blockedProviderNodes.map((name) => ({ name }))]
            }
          }
        });
      }
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: 'node-a',
              all: ['node-a']
            },
            'node-a': {}
          }
        });
      }
      if (decodeURIComponent(path).includes('/proxies/node-b/delay')) {
        return new Response(null, { status: 404 });
      }
      if (decodeURIComponent(path).includes('/providers/proxies/airport/node-b/healthcheck')) {
        providerHealthchecks.push(path);
        return Response.json({ delay: 91 });
      }
      if (path.includes('/delay')) {
        return Response.json({ delay: 80 });
      }
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.testAllNodes();

    expect(providerHealthchecks).toHaveLength(2);
    await expect(api.listNodes()).resolves.toEqual([
      { name: 'node-a', delay: 80, active: true, testState: 'tested' },
      { name: 'node-b', delay: 91, active: false, testState: 'tested' }
    ]);
  });

  it('reports progress after each node delay is cached', async () => {
    const nodeNames = ['progress-node-a', 'progress-node-b', 'progress-node-c'];
    const progress: Array<{ name: string; delay?: number }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: 'progress-node-a',
              all: nodeNames
            },
            ...Object.fromEntries(nodeNames.map((name) => [name, {}]))
          }
        });
      }

      if (path.includes('/delay')) {
        const name = decodeURIComponent(path.match(/\/proxies\/([^/]+)\/delay/)?.[1] ?? '');
        return Response.json({ delay: 70 + nodeNames.indexOf(name) });
      }

      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await api.testAllNodes({
      onNodeTested: (node) => {
        progress.push({ name: node.name, delay: node.delay });
      }
    });

    expect(progress).toHaveLength(6);
    expect(progress.filter((node) => node.delay === undefined)).toHaveLength(3);
    expect(progress.filter((node) => typeof node.delay === 'number')).toHaveLength(3);
    expect(progress.map((node) => node.name).sort()).toEqual([...nodeNames, ...nodeNames].sort());
    await expect(api.listNodes()).resolves.toEqual([
      { name: 'progress-node-a', delay: 70, active: true, testState: 'tested' },
      { name: 'progress-node-b', delay: 71, active: false, testState: 'tested' },
      { name: 'progress-node-c', delay: 72, active: false, testState: 'tested' }
    ]);
  });

  it('selects the fastest usable node after delay testing', async () => {
    let selected = 'broken-node';
    const nodeNames = ['broken-node', 'slow-node', 'fast-node'];
    const delays: Record<string, number> = {
      'broken-node': 2000,
      'slow-node': 180,
      'fast-node': 72
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: selected,
              all: nodeNames
            },
            ...Object.fromEntries(nodeNames.map((name) => [name, {}]))
          }
        });
      }

      if (path.includes('/delay')) {
        const name = decodeURIComponent(path.match(/\/proxies\/([^/]+)\/delay/)?.[1] ?? '');
        return Response.json({ delay: delays[name] ?? 2000 });
      }

      selected = JSON.parse(String(init?.body ?? '{}')).name ?? selected;
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.selectBestUsableNode({ avoidNode: 'broken-node' })).resolves.toBe('fast-node');
    expect(selected).toBe('fast-node');
  });

  it('prefers a usable Japan node over a faster non-Japan node', async () => {
    let selected = 'HK 01';
    const nodeNames = ['HK 01', 'JP Tokyo 01', 'US 01'];
    const delays: Record<string, number> = {
      'HK 01': 72,
      'JP Tokyo 01': 138,
      'US 01': 88
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: selected,
              all: nodeNames
            },
            ...Object.fromEntries(nodeNames.map((name) => [name, {}]))
          }
        });
      }

      if (path.includes('/delay')) {
        const name = decodeURIComponent(path.match(/\/proxies\/([^/]+)\/delay/)?.[1] ?? '');
        return Response.json({ delay: delays[name] ?? 2000 });
      }

      selected = JSON.parse(String(init?.body ?? '{}')).name ?? selected;
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.selectBestUsableNode()).resolves.toBe('JP Tokyo 01');
    expect(selected).toBe('JP Tokyo 01');
  });

  it('selects the fastest usable node inside the auto strategy without leaving auto mode', async () => {
    const autoTarget = strategyTargets.auto;
    let mainNow = autoTarget;
    let autoNow = 'slow-node';
    const nodeNames = ['slow-node', 'fast-node'];
    const delays: Record<string, number> = {
      'slow-node': 180,
      'fast-node': 72
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: mainNow,
              all: [autoTarget, 'DIRECT', ...nodeNames]
            },
            [autoTarget]: {
              type: 'URLTest',
              now: autoNow,
              all: nodeNames
            },
            ...Object.fromEntries(nodeNames.map((name) => [name, {}]))
          }
        });
      }

      if (path.includes('/delay')) {
        const name = decodeURIComponent(path.match(/\/proxies\/([^/]+)\/delay/)?.[1] ?? '');
        return Response.json({ delay: delays[name] ?? 2000 });
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith(`/proxies/${encodeURIComponent(autoTarget)}`)) autoNow = body.name;
      if (path.endsWith('/proxies/Main')) mainNow = body.name;
      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    await expect(api.selectBestUsableNodeForStrategy('auto', { avoidNode: 'slow-node' })).resolves.toBe('fast-node');
    expect(mainNow).toBe(autoTarget);
    expect(autoNow).toBe('fast-node');
  });

  it('aborts all-node delay testing', async () => {
    let firstDelayStarted: (() => void) | undefined;
    const firstDelay = new Promise<void>((resolve) => {
      firstDelayStarted = resolve;
    });
    const controller = new AbortController();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/proxies')) {
        return Response.json({
          proxies: {
            Main: {
              type: 'Selector',
              now: 'node-a',
              all: ['node-a', 'node-b', 'node-c']
            },
            'node-a': {},
            'node-b': {},
            'node-c': {}
          }
        });
      }

      if (path.includes('/delay')) {
        firstDelayStarted?.();
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          setTimeout(() => resolve(Response.json({ delay: 80 })), 5000);
        });
      }

      return new Response(null, { status: 204 });
    });
    const api = createMihomoApiClient({ secret: 'secret', fetcher });

    const onNodeTested = vi.fn();
    const task = api.testAllNodes({ signal: controller.signal, onNodeTested });
    await firstDelay;
    controller.abort();

    await expect(task).rejects.toThrow(/aborted|cancelled/i);
    expect(onNodeTested).toHaveBeenCalled();
    expect(onNodeTested.mock.calls.every(([node]) => node.testState === 'testing')).toBe(true);
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

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/providers/proxies/airport',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret'
        }
      })
    );
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/providers/proxies/backup',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret'
        }
      })
    );
  });
});
