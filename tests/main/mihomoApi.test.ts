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
});
