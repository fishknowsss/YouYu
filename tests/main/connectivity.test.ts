import { describe, expect, it } from 'vitest';
import { parseCurlMetrics, parseTraceData } from '../../src/main/connectivity';

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
