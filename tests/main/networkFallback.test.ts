import { describe, expect, it, vi } from 'vitest';
import { runNetworkFallback, type FetchLike, type NetworkFallbackResponse } from '../../src/main/networkFallback';

type TestResponse = {
  status: number;
  body?: unknown;
};

const response = (status: number, body?: unknown): TestResponse => ({ status, body });

function run(
  direct: (fetch: FetchLike, signal: AbortSignal) => Promise<TestResponse>,
  proxy: (signal: AbortSignal, timeoutMs: number) => Promise<TestResponse>,
  options: {
    proxyUrl?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetch?: FetchLike;
  } = {}
): Promise<NetworkFallbackResponse<TestResponse>> {
  return runNetworkFallback({
    scope: 'test request',
    proxyUrl: options.proxyUrl,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 500,
    fetch: options.fetch,
    getStatus: (value) => value.status,
    direct: ({ fetch, signal }) => direct(fetch, signal),
    proxy: ({ signal, timeoutMs }) => proxy(signal, timeoutMs)
  });
}

describe('runNetworkFallback', () => {
  it('always tries direct first and skips a configured proxy after direct success', async () => {
    const fetch = vi.fn<FetchLike>();
    const direct = vi.fn(async (receivedFetch: FetchLike) => {
      expect(receivedFetch).toBe(fetch);
      return response(200, { ok: true });
    });
    const proxy = vi.fn(async () => response(200));

    await expect(run(direct, proxy, { proxyUrl: 'http://127.0.0.1:7890', fetch })).resolves.toEqual({
      response: { status: 200, body: { ok: true } },
      route: 'direct'
    });
    expect(direct).toHaveBeenCalledOnce();
    expect(proxy).not.toHaveBeenCalled();
  });

  it.each([408, 502, 503, 504])('falls back through the proxy after direct HTTP %s', async (status) => {
    const calls: string[] = [];

    await expect(
      run(
        async () => {
          calls.push('direct');
          return response(status);
        },
        async () => {
          calls.push('proxy');
          return response(200);
        },
        { proxyUrl: 'http://127.0.0.1:7890' }
      )
    ).resolves.toMatchObject({ response: { status: 200 }, route: 'proxy', directOutcome: `HTTP_${status}` });
    expect(calls).toEqual(['direct', 'proxy']);
  });

  it.each([401, 403, 429])('does not change route after direct HTTP %s', async (status) => {
    const proxy = vi.fn(async () => response(200));

    await expect(run(async () => response(status), proxy, { proxyUrl: 'http://127.0.0.1:7890' })).resolves.toEqual({
      response: { status },
      route: 'direct'
    });
    expect(proxy).not.toHaveBeenCalled();
  });

  it('does not change route for a successful HTTP response with an invalid body', async () => {
    const proxy = vi.fn(async () => response(200, { valid: true }));

    await expect(
      run(async () => response(200, undefined), proxy, { proxyUrl: 'http://127.0.0.1:7890' })
    ).resolves.toEqual({ response: { status: 200, body: undefined }, route: 'direct' });
    expect(proxy).not.toHaveBeenCalled();
  });

  it('falls back only after a transport failure', async () => {
    const calls: string[] = [];

    await expect(
      run(
        async () => {
          calls.push('direct');
          throw new TypeError('fetch failed for https://secret.example/u/private');
        },
        async () => {
          calls.push('proxy');
          return response(200);
        },
        { proxyUrl: 'http://127.0.0.1:7890' }
      )
    ).resolves.toMatchObject({ response: { status: 200 }, route: 'proxy', directOutcome: 'FETCH_FAILED' });
    expect(calls).toEqual(['direct', 'proxy']);
  });

  it('does not fall back after a non-transport application failure', async () => {
    const proxy = vi.fn(async () => response(200));

    await expect(
      run(
        async () => {
          throw new Error('invalid application response');
        },
        proxy,
        { proxyUrl: 'http://127.0.0.1:7890' }
      )
    ).rejects.toThrow(/route=direct code=REQUEST_FAILED/);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('preserves a user cancellation and never changes route', async () => {
    const controller = new AbortController();
    const cancellation = new Error('cancel sync');
    const proxy = vi.fn(async () => response(200));
    const direct = vi.fn(
      async (_fetch: FetchLike, signal: AbortSignal) =>
        new Promise<TestResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          controller.abort(cancellation);
        })
    );

    await expect(run(direct, proxy, { proxyUrl: 'http://127.0.0.1:7890', signal: controller.signal })).rejects.toBe(
      cancellation
    );
    expect(proxy).not.toHaveBeenCalled();
  });

  it('preserves a user cancellation that races with the proxy fallback failure', async () => {
    const controller = new AbortController();
    const cancellation = new Error('cancel retry');
    const proxy = vi.fn(
      async (signal: AbortSignal) =>
        new Promise<TestResponse>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('proxy closed'), { code: 'ECONNRESET' })),
            {
              once: true
            }
          );
          controller.abort(cancellation);
        })
    );

    await expect(
      run(
        async () => {
          throw Object.assign(new TypeError('fetch failed'), { code: 'ENOTFOUND' });
        },
        proxy,
        { proxyUrl: 'http://127.0.0.1:7890', signal: controller.signal }
      )
    ).rejects.toBe(cancellation);
    expect(proxy).toHaveBeenCalledOnce();
  });

  it('shares one total timeout budget between direct and proxy routes', async () => {
    let proxyBudget = 0;
    const startedAt = Date.now();

    await expect(
      run(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 35));
          throw new TypeError('fetch failed');
        },
        async (_signal, timeoutMs) => {
          proxyBudget = timeoutMs;
          return response(200);
        },
        { proxyUrl: 'http://127.0.0.1:7890', timeoutMs: 200 }
      )
    ).resolves.toMatchObject({ route: 'proxy' });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(proxyBudget).toBeGreaterThan(0);
    expect(proxyBudget).toBeLessThan(190);
  });

  it('reserves enough total timeout for proxy fallback when direct waits for its route signal', async () => {
    const totalTimeoutMs = 250;
    const startedAt = Date.now();
    let directAbortedAt = 0;
    const proxy = vi.fn(async () => response(200, { ok: true }));

    await expect(
      run(
        async (_fetch, signal) =>
          new Promise<TestResponse>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                directAbortedAt = Date.now();
                reject(signal.reason);
              },
              { once: true }
            );
          }),
        proxy,
        { proxyUrl: 'http://127.0.0.1:7890', timeoutMs: totalTimeoutMs }
      )
    ).resolves.toEqual({
      response: { status: 200, body: { ok: true } },
      route: 'proxy',
      directOutcome: 'DIRECT_ROUTE_TIMEOUT'
    });

    const elapsedMs = Date.now() - startedAt;
    expect(directAbortedAt - startedAt).toBeGreaterThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(totalTimeoutMs - 15);
    expect(proxy).toHaveBeenCalledOnce();
  });

  it('reports only a safe final route and transport code', async () => {
    const secretUrl = 'https://secret.example/api?userId=hidden';
    const secretBody = '{"passphrase":"hidden"}';
    let error: unknown;

    try {
      await run(
        async () => {
          throw new TypeError(`fetch failed ${secretUrl} ${secretBody}`);
        },
        async () => response(200)
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('route=direct');
    expect((error as Error).message).toContain('code=FETCH_FAILED');
    expect((error as Error).message).not.toContain(secretUrl);
    expect((error as Error).message).not.toContain('passphrase');
    expect((error as Error).message).not.toContain('hidden');
    expect((error as Error).cause).toBeUndefined();
  });

  it('keeps both safe transport outcomes when direct and proxy routes fail', async () => {
    let error: unknown;
    const directError = Object.assign(new TypeError('https://secret.example?userId=hidden'), {
      cause: Object.assign(new Error('hidden identity'), { code: 'ENOTFOUND' })
    });
    const proxyError = Object.assign(new Error('{"passphrase":"hidden"}'), { code: 'ECONNREFUSED' });

    try {
      await run(
        async () => {
          throw directError;
        },
        async () => {
          throw proxyError;
        },
        { proxyUrl: 'http://127.0.0.1:7890' }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('route=proxy code=ECONNREFUSED');
    expect((error as Error).message).toContain('direct=ENOTFOUND');
    expect((error as Error).message).toContain('proxy=ECONNREFUSED');
    expect((error as Error).message).not.toContain('secret.example');
    expect((error as Error).message).not.toContain('userId');
    expect((error as Error).message).not.toContain('passphrase');
    expect((error as Error).message).not.toContain('hidden');
  });

  it('keeps a retryable direct HTTP status when the proxy transport fails', async () => {
    const proxyError = Object.assign(new Error('proxy refused'), { code: 'ECONNREFUSED' });

    await expect(
      run(
        async () => response(503),
        async () => {
          throw proxyError;
        },
        { proxyUrl: 'http://127.0.0.1:7890' }
      )
    ).rejects.toThrow(/direct=HTTP_503 proxy=ECONNREFUSED/);
  });
});
