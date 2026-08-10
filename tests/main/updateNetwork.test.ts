import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createHostResolverOptions,
  createUpdateFeedConfig,
  isRecoverableUpdateNetworkError,
  runUpdateCheckWithNetworkFallback,
  runUpdateDownloadWithNetworkFallback,
  type UpdateNetworkSession
} from '../../src/main/updateNetwork';

describe('update network fallback', () => {
  it('enables the built-in resolver, Happy Eyeballs, and multi-provider secure DNS', () => {
    expect(createHostResolverOptions()).toEqual({
      enableBuiltInResolver: true,
      enableHappyEyeballs: true,
      secureDnsMode: 'secure',
      secureDnsServers: [
        'https://doh.pub/dns-query',
        'https://dns.alidns.com/dns-query',
        'https://cloudflare-dns.com/dns-query',
        'https://1.1.1.1/dns-query'
      ]
    });
  });

  it('uses GitHub latest-release assets as a direct generic update feed', () => {
    expect(createUpdateFeedConfig()).toEqual({
      provider: 'generic',
      url: 'https://github.com/fishknowsss/YouYu/releases/latest/download'
    });
  });

  it('prefers a running local proxy, then retries GitHub directly after a transport failure', async () => {
    const calls: string[] = [];
    const session = createSession(calls);
    let attempt = 0;
    const check = vi.fn(async () => {
      calls.push('check');
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });
    });

    await runUpdateCheckWithNetworkFallback({
      session,
      check,
      proxyUrl: 'http://127.0.0.1:7890',
      onRetry: (route, detail) => calls.push(`retry:${route}:${detail}`)
    });

    expect(check).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      'proxy:fixed_servers:http=127.0.0.1:7890;https=127.0.0.1:7890',
      'connections:close',
      'dns:clear',
      'check',
      'proxy:direct',
      'connections:close',
      'dns:clear',
      'retry:direct:ENOTFOUND',
      'check'
    ]);
  });

  it('re-reads the runtime proxy after a startup direct failure and uses it as soon as Mihomo is ready', async () => {
    const calls: string[] = [];
    const session = createSession(calls);
    let proxyRead = 0;
    const getProxyUrl = vi.fn(() => {
      proxyRead += 1;
      return proxyRead === 1 ? undefined : 'http://127.0.0.1:7890';
    });
    const check = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_TIMED_OUT'))
      .mockResolvedValueOnce('ok');

    await expect(
      runUpdateCheckWithNetworkFallback({
        session,
        check,
        getProxyUrl,
        onRetry: (route, detail) => calls.push(`retry:${route}:${detail}`)
      })
    ).resolves.toBe('ok');

    expect(getProxyUrl).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      'proxy:direct',
      'connections:close',
      'dns:clear',
      'proxy:fixed_servers:http=127.0.0.1:7890;https=127.0.0.1:7890',
      'connections:close',
      'dns:clear',
      'retry:local-proxy:ERR_CONNECTION_TIMED_OUT'
    ]);
  });

  it('returns after metadata and retries a background download through the local proxy without waiting in check', async () => {
    const calls: string[] = [];
    const session = createSession(calls);
    const metadata = { isUpdateAvailable: true, version: '1.6.0' };
    const check = vi.fn(async () => {
      calls.push('check');
      return metadata;
    });
    let finishDownload: ((paths: string[]) => void) | undefined;
    const proxyDownload = new Promise<string[]>((resolve) => {
      finishDownload = resolve;
    });
    const download = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(Object.assign(new Error('asset fetch failed'), { code: 'ENOTFOUND' }))
      .mockImplementationOnce(async () => proxyDownload);

    await expect(runUpdateCheckWithNetworkFallback({ session, check })).resolves.toBe(metadata);
    expect(download).not.toHaveBeenCalled();

    let downloadSettled = false;
    const downloading = runUpdateDownloadWithNetworkFallback({
      session,
      download,
      proxyUrl: 'http://127.0.0.1:7890',
      onRetry: (route, detail) => calls.push(`download-retry:${route}:${detail}`)
    }).finally(() => {
      downloadSettled = true;
    });

    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(downloadSettled).toBe(false);
    expect(calls).toContain('proxy:fixed_servers:http=127.0.0.1:7890;https=127.0.0.1:7890');
    expect(calls).toContain('download-retry:direct:ENOTFOUND');

    finishDownload?.(['YouYu-1.6.0-x64.exe']);
    await expect(downloading).resolves.toEqual(['YouYu-1.6.0-x64.exe']);
  });

  it('passes the selected route and attempt number to each operation', async () => {
    const calls: string[] = [];
    const session = createSession(calls);
    const attempts: string[] = [];

    await runUpdateDownloadWithNetworkFallback({
      session,
      proxyUrl: 'http://127.0.0.1:7890',
      download: async ({ route, attempt }) => {
        attempts.push(`${attempt}:${route}`);
        if (attempt === 1) {
          throw Object.assign(new Error('route health rejected'), { code: 'ERR_UPDATE_ROUTE_UNHEALTHY' });
        }
        return 'ok';
      }
    });

    expect(attempts).toEqual(['1:local-proxy', '2:direct']);
  });

  it('wires metadata checks to a guarded non-blocking explicit download', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const coordinator = await readFile('src/main/updateCoordinator.ts', 'utf8');
    const checkStart = coordinator.indexOf('async function runCheck');
    const checkEnd = coordinator.indexOf('\n  function download()', checkStart);
    const checkHandler = coordinator.slice(checkStart, checkEnd);

    expect(source).toContain('autoUpdater.autoDownload = false;');
    expect(source).toContain('createUpdateCoordinator({');
    expect(source).toContain('executeCheck: () =>');
    expect(source).toContain('executeDownload: async () =>');
    expect(source).toContain('runUpdateCheckWithNetworkFallback');
    expect(source).toContain('runUpdateDownloadWithNetworkFallback');
    expect(source).toContain('getProxyUrl: getRuntimeTrafficProxyUrl');
    expect(source).not.toContain('检查更新直连失败');
    expect(source).not.toContain('更新下载直连失败');
    expect(checkHandler).toContain('void download();');
    expect(checkHandler).not.toContain('await download()');
    expect(coordinator).toContain('if (checkFlight) {');
    expect(coordinator).toContain('return checkFlight.promise;');
    expect(coordinator).toContain('if (downloadFlight) return downloadFlight.promise;');
  });

  it('refreshes the direct connection and DNS cache once when no local proxy is available', async () => {
    const calls: string[] = [];
    const session = createSession(calls);
    let attempt = 0;
    const check = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('net::ERR_NAME_NOT_RESOLVED');
    });

    await runUpdateCheckWithNetworkFallback({ session, check });

    expect(check).toHaveBeenCalledTimes(2);
    expect(calls.filter((value) => value === 'proxy:direct')).toHaveLength(2);
    expect(calls.filter((value) => value === 'dns:clear')).toHaveLength(2);
  });

  it('does not retry HTTP failures that another route must not hide', async () => {
    const calls: string[] = [];
    const session = createSession(calls);
    const check = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('HTTP 403'));

    await expect(
      runUpdateCheckWithNetworkFallback({ session, check, proxyUrl: 'http://127.0.0.1:7890' })
    ).rejects.toThrow('HTTP 403');

    expect(check).toHaveBeenCalledOnce();
    expect(calls.some((value) => value.startsWith('proxy:fixed_servers'))).toBe(true);
    expect(calls.filter((value) => value === 'proxy:direct')).toHaveLength(0);
  });

  it('does not retry a wrapped certificate failure even when the outer message says fetch failed', async () => {
    const calls: string[] = [];
    const session = createSession(calls);
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('certificate rejected'), { code: 'ERR_CERT_AUTHORITY_INVALID' })
    });
    const download = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(
      runUpdateDownloadWithNetworkFallback({
        session,
        download,
        proxyUrl: 'http://127.0.0.1:7890'
      })
    ).rejects.toBe(error);

    expect(download).toHaveBeenCalledOnce();
    expect(calls.some((value) => value.startsWith('proxy:fixed_servers'))).toBe(true);
    expect(calls.filter((value) => value === 'proxy:direct')).toHaveLength(0);
    expect(isRecoverableUpdateNetworkError(error)).toBe(false);
  });

  it.each([
    Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('lookup failed'), { code: 'EAI_AGAIN' })
    }),
    new Error('net::ERR_INTERNET_DISCONNECTED'),
    new Error('request timed out'),
    new Error('ECONNRESET'),
    Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }),
    Object.assign(new Error('route health rejected'), { code: 'ERR_UPDATE_ROUTE_UNHEALTHY' }),
    new Error('net::ERR_TUNNEL_CONNECTION_FAILED')
  ])('recognizes recoverable update transport failures', (error) => {
    expect(isRecoverableUpdateNetworkError(error)).toBe(true);
  });
});

function createSession(calls: string[]): UpdateNetworkSession {
  return {
    setProxy: vi.fn(async (config) => {
      calls.push(`proxy:${config.mode}${config.proxyRules ? `:${config.proxyRules}` : ''}`);
    }),
    closeAllConnections: vi.fn(async () => {
      calls.push('connections:close');
    }),
    clearHostResolverCache: vi.fn(async () => {
      calls.push('dns:clear');
    })
  };
}
