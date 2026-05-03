import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildMihomoConfig } from '../../src/main/mihomo/config';

describe('buildMihomoConfig', () => {
  it('builds a local-only mihomo config with a provider and secret', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub?token=secret',
      secret: 'local-secret'
    });
    const config = parse(yamlText);

    expect(config['mixed-port']).toBe(7890);
    expect(config['allow-lan']).toBe(false);
    expect(config['external-controller']).toBe('127.0.0.1:9090');
    expect(config.secret).toBe('local-secret');
    expect(config['geo-auto-update']).toBe(false);
    expect(config['geodata-mode']).toBe(false);
    expect(config['proxy-providers'].airport.url).toBe('https://example.com/sub?token=secret');
    expect(config['proxy-providers'].airport.interval).toBe(43200);
    expect(config['proxy-groups'][0].name).toBe('节点选择');
    expect(config['proxy-groups'].map((group: { name: string }) => group.name)).toEqual([
      '节点选择',
      '自动选择',
      '故障转移',
      '负载均衡'
    ]);
    expect(config.dns.enable).toBe(true);
    expect(config.dns.listen).toBe('127.0.0.1:1053');
    expect(config.dns.fallback).toBeUndefined();
    expect(config.dns['fallback-filter']).toBeUndefined();
    expect(config.sniffer.enable).toBe(true);
    expect(config.rules).toContain('DOMAIN-SUFFIX,cn,DIRECT');
    expect(config.rules).toContain('MATCH,节点选择');
  });

  it('uses the allocated dns listener port', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      dnsPort: 1099
    });
    const config = parse(yamlText);

    expect(config.dns.listen).toBe('127.0.0.1:1099');
  });

  it('inlines subscription proxies before mihomo starts', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      subscriptionConfigText: `
proxies:
  - name: 香港 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: 🇯🇵 日本 09 家宽
    type: ss
    server: 127.0.0.1
    port: 8389
    cipher: aes-128-gcm
    password: pass
`
    });
    const config = parse(yamlText);

    expect(config['proxy-providers']).toBeUndefined();
    expect(config.proxies.map((proxy: { name: string }) => proxy.name)).toEqual([
      '香港 01',
      '🇯🇵 日本 09 家宽'
    ]);
    expect(config['proxy-groups'][0]).toMatchObject({
      name: '节点选择',
      type: 'select'
    });
    expect(config['proxy-groups'][0].proxies[1]).toBe('🇯🇵 日本 09 家宽');
    expect(config['proxy-groups'][1].proxies[0]).toBe('🇯🇵 日本 09 家宽');
    expect(config.rules).toContain('MATCH,节点选择');
  });

  it('removes subscription notice nodes from the inlined config', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      subscriptionConfigText: `
proxies:
  - name: 香港 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: 你使用的代理客户端已失去支持
    type: ss
    server: 127.0.0.1
    port: 8389
    cipher: aes-128-gcm
    password: pass
`
    });
    const config = parse(yamlText);

    expect(config.proxies.map((proxy: { name: string }) => proxy.name)).toEqual(['香港 01']);
    expect(config['proxy-groups'][0].proxies).not.toContain('你使用的代理客户端已失去支持');
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
  - name: 香港 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - 香港 01
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
    expect(config.rules).toEqual(['DOMAIN-SUFFIX,example.com,PROXY', 'MATCH,DIRECT']);
  });
});
