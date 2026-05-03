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

  it('can preserve a full airport config while injecting local runtime controls', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'subscription',
      subscriptionConfigText: `
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
  - MATCH,DIRECT
`
    });
    const config = parse(yamlText);

    expect(config['external-controller']).toBe('127.0.0.1:9090');
    expect(config.secret).toBe('local-secret');
    expect(config.rules).toEqual(['DOMAIN-SUFFIX,example.com,PROXY', 'MATCH,DIRECT']);
  });
});
