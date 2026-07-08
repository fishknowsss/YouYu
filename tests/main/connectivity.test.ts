import { describe, expect, it } from 'vitest';
import { connectivityServices, parseCurlMetrics, parseTraceData } from '../../src/main/connectivity';

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
  it('keeps the availability list with gaming, AI, development, captcha, and global services', () => {
    expect(connectivityServices[0]).toMatchObject({
      key: 'steam',
      name: 'Steam',
      host: 'store.steampowered.com'
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
    expect(connectivityServices).toHaveLength(16);
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
        expect.objectContaining({ key: 'github', host: 'github.com' }),
        expect.objectContaining({ key: 'microsoftStore', host: 'apps.microsoft.com' }),
        expect.objectContaining({ key: 'discord', host: 'discord.com' }),
        expect.objectContaining({ key: 'turnstile', host: 'challenges.cloudflare.com' }),
        expect.objectContaining({ key: 'recaptcha', host: 'www.recaptcha.net' }),
        expect.objectContaining({ key: 'hcaptcha', host: 'js.hcaptcha.com' })
      ])
    );
    expect(connectivityServices.map((service) => service.key)).not.toEqual(
      expect.arrayContaining(['bytedance', 'runway', 'tencent', 'ehentai'])
    );
  });
});
