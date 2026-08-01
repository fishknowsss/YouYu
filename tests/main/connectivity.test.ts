import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectivityServices,
  parseCurlMetrics,
  parseTraceData,
  testAllConnectivity,
  testConnectivity
} from '../../src/main/connectivity';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseCurlMetrics', () => {
  it('reads curl timing output and keeps the response body', () => {
    const result = parseCurlMetrics(
      '{"ok":true}\n__YOUYU_CURL_METRICS__\nhttp_code=200\nurl_effective=https://example.com\nremote_ip=93.184.216.34\ntime_connect=0.048120\ntime_appconnect=0.162520\ntime_starttransfer=0.238411\ntime_total=0.251908\n'
    );

    expect(result.httpCode).toBe(200);
    expect(result.finalUrl).toBe('https://example.com');
    expect(result.remoteIp).toBe('93.184.216.34');
    expect(result.body).toContain('"ok":true');
    expect(result.timings).toEqual({
      connectMs: 48,
      tlsMs: 163,
      firstByteMs: 238,
      totalMs: 252
    });
  });

  it('ignores zero timing values', () => {
    const result = parseCurlMetrics(
      '\n__YOUYU_CURL_METRICS__\nhttp_code=000\nurl_effective=\nremote_ip=\ntime_connect=0.000000\ntime_appconnect=0.000000\ntime_starttransfer=0.000000\ntime_total=0.000000\n'
    );

    expect(result.httpCode).toBeUndefined();
    expect(result.timings.totalMs).toBeUndefined();
  });
});

describe('parseTraceData', () => {
  it('reads Cloudflare trace ip and edge data', () => {
    const result = parseTraceData('fl=80f440\nh=chatgpt.com\nip=126.63.231.113\ncolo=NRT\nloc=JP\nwarp=off\n');

    expect(result).toEqual({
      ip: '126.63.231.113',
      loc: 'JP',
      colo: 'NRT'
    });
  });
});

describe('connectivityServices', () => {
  it('keeps the 15-site availability list with gaming, AI, captcha, and global services', () => {
    expect(connectivityServices[0]).toMatchObject({
      key: 'steam',
      name: 'Steam',
      host: 'store.steampowered.com',
      probeUrl: 'https://store.steampowered.com/robots.txt'
    });
    expect(connectivityServices[1]).toMatchObject({
      key: 'steamNetwork',
      name: 'Steam 联机',
      host: 'api.steampowered.com'
    });
    expect(connectivityServices[2]).toMatchObject({
      key: 'steamCloud',
      name: 'Steam 云同步',
      host: 'steamcloud-ugc.storage.googleapis.com'
    });
    expect(connectivityServices).toHaveLength(15);
    expect(connectivityServices).toContainEqual(
      expect.objectContaining({
        key: 'pixverse',
        name: 'PixVerse',
        url: 'https://app.pixverse.ai',
        probeUrl: 'https://app.pixverse.ai',
        host: 'app.pixverse.ai'
      })
    );
    expect(connectivityServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'microsoftStore', host: 'apps.microsoft.com' }),
        expect.objectContaining({ key: 'discord', host: 'discord.com' }),
        expect.objectContaining({ key: 'turnstile', host: 'challenges.cloudflare.com' }),
        expect.objectContaining({ key: 'recaptcha', host: 'www.recaptcha.net' }),
        expect.objectContaining({ key: 'hcaptcha', host: 'js.hcaptcha.com' })
      ])
    );
    expect(connectivityServices.map((service) => service.key)).not.toEqual(
      expect.arrayContaining(['github', 'bytedance', 'runway', 'tencent', 'ehentai'])
    );
  });
});

describe('testConnectivity cancellation', () => {
  it('propagates cancellation to an in-flight curl probe', async () => {
    const controller = new AbortController();
    const runProbe = vi.fn(
      (_url: string, _mixedPort: number, options: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        })
    );
    const pending = testConnectivity(
      {
        getMixedPort: () => 7890,
        getControllerPort: () => 9090,
        getControllerSecret: async () => 'secret',
        isRunning: () => true
      },
      'steam',
      { signal: controller.signal, runProbe }
    );

    await vi.waitFor(() => expect(runProbe).toHaveBeenCalledOnce());
    controller.abort(new Error('operation canceled'));

    await expect(pending).rejects.toThrow('operation canceled');
    expect(runProbe.mock.calls[0]?.[2].signal).toBe(controller.signal);
  });

  it('propagates cancellation through every active all-site worker', async () => {
    const controller = new AbortController();
    const runProbe = vi.fn(
      (_url: string, _mixedPort: number, options: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        })
    );
    const pending = testAllConnectivity(
      {
        getMixedPort: () => 7890,
        getControllerPort: () => 9090,
        getControllerSecret: async () => 'secret',
        isRunning: () => true
      },
      { signal: controller.signal, runProbe }
    );
    await vi.waitFor(() => expect(runProbe).toHaveBeenCalledTimes(3));

    controller.abort(new Error('availability canceled'));

    await expect(pending).rejects.toThrow('availability canceled');
    expect(runProbe.mock.calls.every((call) => call[2].signal === controller.signal)).toBe(true);
  });

  it('does not turn cancellation during the Cloudflare IP lookup into a successful result', async () => {
    const controller = new AbortController();
    let lookupStartedResolve: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      lookupStartedResolve = resolve;
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:')) return Response.json({ connections: [] });
      lookupStartedResolve?.();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const pending = testConnectivity(
      {
        getMixedPort: () => 7890,
        getControllerPort: () => 9090,
        getControllerSecret: async () => 'secret',
        isRunning: () => true
      },
      'cloudflare',
      {
        signal: controller.signal,
        runProbe: async () => ({
          httpCode: 200,
          finalUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
          body: 'ip=126.63.231.113\nloc=JP\ncolo=NRT\n',
          timings: { totalMs: 120 }
        })
      }
    );
    await lookupStarted;

    controller.abort(new Error('IP lookup canceled'));

    await expect(pending).rejects.toThrow('IP lookup canceled');
    expect(fetcher).toHaveBeenLastCalledWith(
      'http://ip-api.com/json/126.63.231.113?fields=status,country,query',
      expect.objectContaining({ signal: controller.signal })
    );
  });
});

describe('connectivity response limits', () => {
  it('cancels an oversized external IP lookup and falls back to the trace region', async () => {
    let canceledWith: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).startsWith('http://127.0.0.1:')) return Response.json({ connections: [] });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":"success","country":"Oversized"}'));
              controller.close();
            },
            cancel(reason) {
              canceledWith = reason;
            }
          }),
          { status: 200, headers: { 'content-length': String(32 * 1024 + 1) } }
        );
      })
    );

    const result = await testConnectivity(
      {
        getMixedPort: () => 7890,
        getControllerPort: () => 9090,
        getControllerSecret: async () => 'secret',
        isRunning: () => true
      },
      'cloudflare',
      {
        runProbe: async () => ({
          httpCode: 200,
          finalUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
          body: 'ip=126.63.231.113\nloc=JP\ncolo=NRT\n',
          timings: { totalMs: 120 }
        })
      }
    );

    expect(result.region).toBe('JP');
    expect(canceledWith).toMatchObject({ code: 'RESPONSE_BODY_TOO_LARGE' });
  });
});

describe('Steam connectivity resilience', () => {
  it('retries one transient Steam TLS failure before reporting the node as failed', async () => {
    const runProbe = vi
      .fn()
      .mockRejectedValueOnce(new Error('curl: (28) SSL connection timeout'))
      .mockResolvedValueOnce({
        httpCode: 200,
        finalUrl: 'https://store.steampowered.com/robots.txt',
        timings: { totalMs: 720 }
      });

    const result = await testConnectivity(
      {
        getMixedPort: () => 7890,
        getControllerPort: () => 9090,
        getControllerSecret: async () => 'secret',
        isRunning: () => true
      },
      'steam',
      { runProbe }
    );

    expect(runProbe).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'available', statusText: '可用', httpCode: 200 });
  });

  it('reports the failing stage after both Steam attempts time out', async () => {
    const runProbe = vi.fn().mockRejectedValue(new Error('curl: (28) SSL connection timeout'));

    const result = await testConnectivity(
      {
        getMixedPort: () => 7890,
        getControllerPort: () => 9090,
        getControllerSecret: async () => 'secret',
        isRunning: () => true
      },
      'steamCloud',
      { runProbe }
    );

    expect(runProbe).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'timeout', statusText: '超时', error: 'TLS 握手超时' });
  });

  it('does not retry a Steam certificate validation failure', async () => {
    const runProbe = vi.fn().mockRejectedValue(new Error('curl: (60) SSL certificate problem'));

    const result = await testConnectivity(
      {
        getMixedPort: () => 7890,
        getControllerPort: () => 9090,
        getControllerSecret: async () => 'secret',
        isRunning: () => true
      },
      'steam',
      { runProbe }
    );

    expect(runProbe).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'failed', statusText: '失败', error: 'TLS 证书校验失败' });
  });
});
