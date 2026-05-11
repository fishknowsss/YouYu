import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildMihomoConfig } from '../../src/main/mihomo/config';

describe('buildMihomoConfig', () => {
  it('builds a local-only mihomo config with Steam priority rules and direct LAN ranges', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub?token=secret',
      secret: 'local-secret'
    });
    const config = parse(yamlText);
    const selector = config['proxy-groups'][0].name;

    expect(config['mixed-port']).toBe(7890);
    expect(config['allow-lan']).toBe(false);
    expect(config['external-controller']).toBe('127.0.0.1:9090');
    expect(config.secret).toBe('local-secret');
    expect(config['geo-auto-update']).toBe(false);
    expect(config['geodata-mode']).toBe(false);
    expect(config['proxy-providers'].airport.url).toBe('https://example.com/sub?token=secret');
    expect(config['proxy-providers'].airport.interval).toBe(43200);
    expect(config['proxy-providers'].airport['health-check'].interval).toBe(1800);
    expect(config['proxy-groups'].map((group: { name: string }) => group.name)).toHaveLength(4);
    expect(config['proxy-groups'][1]).toMatchObject({
      type: 'url-test',
      interval: 1800,
      tolerance: 150
    });
    expect(config.dns).toBeUndefined();
    expect(config.sniffer.enable).toBe(true);
    expect(config.rules[0]).toBe(`DOMAIN-SUFFIX,flow.google.com,${selector}`);
    expect(config.rules).toEqual(
      expect.arrayContaining([
        `DOMAIN-SUFFIX,steampowered.com,${selector}`,
        `DOMAIN-SUFFIX,api.steampowered.com,${selector}`,
        `DOMAIN-SUFFIX,steamcommunity.com,${selector}`,
        `DOMAIN-SUFFIX,steamcdn-a.akamaihd.net,${selector}`,
        'DOMAIN-SUFFIX,cn,DIRECT',
        'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
        'IP-CIDR,224.0.0.0/4,DIRECT,no-resolve',
        'IP-CIDR,255.255.255.255/32,DIRECT,no-resolve',
        `MATCH,${selector}`
      ])
    );
  });

  it('injects local DNS only when DNS enhancement is enabled', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      dnsEnhanced: true,
      dnsPort: 1099
    });
    const config = parse(yamlText);

    expect(config.dns.enable).toBe(true);
    expect(config.dns.listen).toBe('127.0.0.1:1099');
    expect(config.dns.fallback).toBeUndefined();
    expect(config.dns['fallback-filter']).toBeUndefined();
    expect(config.dns['fake-ip-filter']).toEqual(
      expect.arrayContaining(['*.steampowered.com', 'steamcdn-a.akamaihd.net', 'stun.*.*'])
    );
  });

  it('enables TUN with strict routing when requested', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      tunEnabled: true,
      strictRouteEnabled: true
    });
    const config = parse(yamlText);

    expect(config.tun).toMatchObject({
      enable: true,
      stack: 'mixed',
      'auto-route': true,
      'auto-detect-interface': true,
      'strict-route': true
    });
    expect(config.tun['dns-hijack']).toEqual(['any:53', 'tcp://any:53']);
  });

  it('inlines subscription proxies before mihomo starts', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      subscriptionConfigText: `
proxies:
  - name: HK 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: TW 08 Home
    type: ss
    server: 127.0.0.1
    port: 8389
    cipher: aes-128-gcm
    password: pass
`
    });
    const config = parse(yamlText);

    expect(config['proxy-providers']).toBeUndefined();
    expect(config.proxies.map((proxy: { name: string }) => proxy.name)).toEqual(['HK 01', 'TW 08 Home']);
    expect(config['proxy-groups'][0].type).toBe('select');
    expect(config['proxy-groups'][0].proxies).toEqual(expect.arrayContaining(['HK 01', 'TW 08 Home']));
    expect(config['proxy-groups'][1].proxies).toEqual(['HK 01', 'TW 08 Home']);
    expect(config['proxy-groups'][1]).toMatchObject({
      type: 'url-test',
      interval: 1800,
      tolerance: 150
    });
    expect(config.rules).toContain(`MATCH,${config['proxy-groups'][0].name}`);
  });

  it('can preserve a full airport config while injecting local runtime controls', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'subscription',
      mixedPort: 7990,
      controllerPort: 9190,
      subscriptionConfigText: `
port: 7890
socks-port: 7891
redir-port: 7892
tproxy-port: 7893
mixed-port: 7894
dns:
  enable: true
  nameserver:
    - 8.8.8.8
  fallback:
    - 1.1.1.1
  fallback-filter:
    geoip: true
    geoip-code: CN
proxies:
  - name: HK 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - HK 01
rules:
  - DOMAIN-SUFFIX,example.com,PROXY
  - GEOSITE,cn,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,DIRECT
`
    });
    const config = parse(yamlText);

    expect(config.port).toBeUndefined();
    expect(config['socks-port']).toBeUndefined();
    expect(config['redir-port']).toBeUndefined();
    expect(config['tproxy-port']).toBeUndefined();
    expect(config['mixed-port']).toBe(7990);
    expect(config['external-controller']).toBe('127.0.0.1:9190');
    expect(config.secret).toBe('local-secret');
    expect(config.dns.fallback).toBeUndefined();
    expect(config.dns['fallback-filter']).toBeUndefined();
    expect(config.rules.slice(0, 26)).toEqual(
      expect.arrayContaining([
        'DOMAIN-SUFFIX,flow.google.com,PROXY',
        'DOMAIN-SUFFIX,steampowered.com,PROXY',
        'DOMAIN-SUFFIX,api.steampowered.com,PROXY',
        'DOMAIN-SUFFIX,steamcommunity.com,PROXY',
        'DOMAIN-SUFFIX,steamcdn-a.akamaihd.net,PROXY',
        'DOMAIN-SUFFIX,steamstore-a.akamaihd.net,PROXY',
        'DOMAIN-SUFFIX,steamuserimages-a.akamaihd.net,PROXY'
      ])
    );
    expect(config.rules).toContain('DOMAIN-SUFFIX,example.com,PROXY');
    expect(config.rules).toContain('MATCH,DIRECT');
    expect(config.rules).not.toContain('GEOSITE,cn,DIRECT');
    expect(config.rules).not.toContain('GEOIP,CN,DIRECT');
  });

  it('uses global rules for full airport configs when requested', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'global',
      subscriptionConfigText: `
proxies:
  - name: HK 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - HK 01
rules:
  - DOMAIN-SUFFIX,example.com,DIRECT
  - MATCH,DIRECT
`
    });
    const config = parse(yamlText);

    expect(config.rules).toContain('DOMAIN-SUFFIX,flow.google.com,PROXY');
    expect(config.rules).toContain('MATCH,PROXY');
    expect(config.rules).not.toContain('DOMAIN-SUFFIX,example.com,DIRECT');
    expect(config.rules).not.toContain('MATCH,DIRECT');
  });

  it('uses local smart rules for full airport configs when requested', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'smart',
      subscriptionConfigText: `
proxies:
  - name: HK 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - HK 01
rules:
  - DOMAIN-SUFFIX,example.com,DIRECT
  - MATCH,DIRECT
`
    });
    const config = parse(yamlText);

    expect(config.rules).toContain('DOMAIN-SUFFIX,flow.google.com,PROXY');
    expect(config.rules).toContain('DOMAIN-SUFFIX,cn,DIRECT');
    expect(config.rules).toContain('MATCH,PROXY');
    expect(config.rules).not.toContain('DOMAIN-SUFFIX,example.com,DIRECT');
    expect(config.rules).not.toContain('MATCH,DIRECT');
  });
});
