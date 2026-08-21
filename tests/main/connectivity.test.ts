import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectivityServices,
  parseCurlMetrics,
  parseTraceData,
  probeProxyExitRegionCode,
  runCurlProbe,
  testAllConnectivity,
  testConnectivity,
  type CurlProbeExecutor
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

describe('probeProxyExitRegionCode', () => {
  it('uses the active proxy path and returns a normalized exit country code', async () => {
    const runProbe = vi.fn(async () => ({
      body: 'ip=203.0.113.10\nloc=jp\ncolo=NRT\n',
      httpCode: 200,
      finalUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
      timings: {}
    }));

    await expect(probeProxyExitRegionCode(7890, { runProbe })).resolves.toBe('JP');
    expect(runProbe).toHaveBeenCalledWith(
      'https://www.cloudflare.com/cdn-cgi/trace',
      7890,
      expect.objectContaining({ captureBody: true })
    );
  });
});

describe('curl probe network boundary', () => {
  it('rejects a non-HTTPS target before starting curl', async () => {
    const executeCurl = vi.fn<CurlProbeExecutor>();

    await expect(runCurlProbe('http://example.com/trace', 7890, { captureBody: true }, executeCurl)).rejects.toThrow(
      'connectivity probe requires HTTPS'
    );
    expect(executeCurl).not.toHaveBeenCalled();
  });

  it('rejects a captured response body above the trace limit', async () => {
    const executeCurl = vi.fn<CurlProbeExecutor>(async () => ({
      stdout: `${'a'.repeat(32 * 1024 + 1)}\n__YOUYU_CURL_METRICS__\nhttp_code=200\nurl_effective=https://example.com/trace\n`
    }));

    await expect(
      runCurlProbe('https://example.com/trace', 7890, { captureBody: true }, executeCurl)
    ).rejects.toMatchObject({ code: 'RESPONSE_BODY_TOO_LARGE' });
  });

  it('routes HTTPS through the active Mihomo proxy with bounded timeouts and cancellation', async () => {
    const controller = new AbortController();
    const executeCurl = vi.fn<CurlProbeExecutor>(async () => ({
      stdout:
        'ip=203.0.113.10\nloc=JP\n\n__YOUYU_CURL_METRICS__\nhttp_code=200\nurl_effective=https://example.com/trace\n'
    }));

    await runCurlProbe(
      'https://example.com/trace',
      7891,
      { captureBody: true, signal: controller.signal },
      executeCurl
    );

    const [command, args, options] = executeCurl.mock.calls[0] ?? [];
    const valueAfter = (flag: string) => args?.[args.indexOf(flag) + 1];
    expect(command).toMatch(/^curl(?:\.exe)?$/);
    expect(valueAfter('--proxy')).toBe('http://127.0.0.1:7891');
    expect(valueAfter('--max-time')).toBe('20');
    expect(valueAfter('--connect-timeout')).toBe('8');
    expect(valueAfter('--max-filesize')).toBe(String(32 * 1024));
    expect(args?.at(-1)).toBe('https://example.com/trace');
    expect(options).toMatchObject({ signal: controller.signal, maxBuffer: 40 * 1024, encoding: 'utf8' });
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

  it('maps the Cloudflare trace location locally without an extra geography request', async () => {
    const fetcher = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ connections: [] })
    );
    vi.stubGlobal('fetch', fetcher);
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

    expect(result.region).toBe('日本');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://127.0.0.1:9090/connections');
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
