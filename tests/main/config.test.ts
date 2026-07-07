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
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('剩余流量');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('中转');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('cloudflare');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('congyu\\.org');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('全球直连');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('节点选择');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('自动选择');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('全球拦截');
    expect(config['proxy-providers'].airport['health-check'].interval).toBe(1800);
    expect(config['proxy-groups'].map((group: { name: string }) => group.name)).toHaveLength(4);
    expect(config['proxy-groups'][1]).toMatchObject({
      type: 'url-test',
      interval: 1800,
      tolerance: 150
    });
    expect(config.dns).toBeUndefined();
    expect(config.tun).toBeUndefined();
    expect(config.sniffer.enable).toBe(true);
    expect(config.rules[0]).toBe('PROCESS-NAME,ToDesk.exe,DIRECT');
    expect(config.rules).toEqual(
      expect.arrayContaining([
        `PROCESS-NAME,Steam.exe,${selector}`,
        `PROCESS-NAME,steamwebhelper.exe,${selector}`,
        `DOMAIN-SUFFIX,flow.google.com,${selector}`,
        `DOMAIN-SUFFIX,steampowered.com,${selector}`,
        `DOMAIN-SUFFIX,api.steampowered.com,${selector}`,
        `DOMAIN-SUFFIX,steamcommunity.com,${selector}`,
        `DOMAIN-SUFFIX,steamcdn-a.akamaihd.net,${selector}`,
        `DOMAIN-SUFFIX,steamcloud-ugc.storage.googleapis.com,${selector}`,
        'DOMAIN-SUFFIX,cn,DIRECT',
        'DOMAIN-SUFFIX,feishu.cn,DIRECT',
        'DOMAIN-SUFFIX,dingtalk.com,DIRECT',
        'DOMAIN-SUFFIX,douyin.com,DIRECT',
        'DOMAIN-SUFFIX,weixin.qq.com,DIRECT',
        'DOMAIN-SUFFIX,xiaohongshu.com,DIRECT',
        'PROCESS-NAME,WeChat.exe,DIRECT',
        'PROCESS-NAME,DingTalk.exe,DIRECT',
        'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
        'IP-CIDR,224.0.0.0/4,DIRECT,no-resolve',
        'IP-CIDR,255.255.255.255/32,DIRECT,no-resolve',
        `MATCH,${selector}`
      ])
    );
  });

  it('puts remote desktop and remote managed rules before proxy priority rules', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub?token=secret',
      secret: 'local-secret',
      remoteConfig: {
        version: 2,
        enabled: true,
        directRules: ['DOMAIN-SUFFIX,remote.example.com'],
        proxyRules: ['DOMAIN-SUFFIX,ai.example.com,PROXY']
      }
    });
    const config = parse(yamlText);
    const selector = config['proxy-groups'][0].name;

    expect(config.rules.slice(0, 4)).toEqual([
      'PROCESS-NAME,ToDesk.exe,DIRECT',
      'PROCESS-NAME,ToDesk_Service.exe,DIRECT',
      'PROCESS-NAME,ToDesk_Lite.exe,DIRECT',
      'PROCESS-NAME,SunloginClient.exe,DIRECT'
    ]);
    expect(config.rules).toContain('DOMAIN-SUFFIX,remote.example.com,DIRECT');
    expect(config.rules).toContain(`DOMAIN-SUFFIX,ai.example.com,${selector}`);
    expect(config.rules.indexOf('DOMAIN-SUFFIX,remote.example.com,DIRECT')).toBeLessThan(
      config.rules.indexOf(`DOMAIN-SUFFIX,flow.google.com,${selector}`)
    );
    expect(config.rules.filter((rule: string) => rule === 'PROCESS-NAME,ToDesk.exe,DIRECT')).toHaveLength(1);
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
      expect.arrayContaining([
        '*.steampowered.com',
        'steamcdn-a.akamaihd.net',
        'steamcloud-ugc.storage.googleapis.com',
        'stun.*.*'
      ])
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
  - name: 剩余流量：796.81 GB
    type: ss
    server: 127.0.0.1
    port: 8387
    cipher: aes-128-gcm
    password: pass
  - name: 中国联通 订阅地址
    type: ss
    server: 127.0.0.1
    port: 8390
    cipher: aes-128-gcm
    password: pass
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

  it('keeps carrier optimized nodes while removing subscription notices', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      subscriptionConfigText: `
proxies:
  - name: 中国移动 香港 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: 中国联通 订阅地址
    type: ss
    server: 127.0.0.1
    port: 8389
    cipher: aes-128-gcm
    password: pass
  - name: 中国移动 剩余流量 100 GB
    type: ss
    server: 127.0.0.1
    port: 8391
    cipher: aes-128-gcm
    password: pass
  - name: 联通移动用中转，电信移动cf
    type: ss
    server: 127.0.0.1
    port: 8392
    cipher: aes-128-gcm
    password: pass
  - name: HK 丛雨云
    type: ss
    server: 127.0.0.1
    port: 8393
    cipher: aes-128-gcm
    password: pass
  - name: 日本 全部超时 01
    type: ss
    server: 127.0.0.1
    port: 8394
    cipher: aes-128-gcm
    password: pass
  - name: twcongyu.org 🐱
    type: ss
    server: 127.0.0.1
    port: 8395
    cipher: aes-128-gcm
    password: pass
  - name: 全球直连
    type: ss
    server: 127.0.0.1
    port: 8396
    cipher: aes-128-gcm
    password: pass
  - name: 节点选择
    type: ss
    server: 127.0.0.1
    port: 8397
    cipher: aes-128-gcm
    password: pass
  - name: 自动选择
    type: ss
    server: 127.0.0.1
    port: 8398
    cipher: aes-128-gcm
    password: pass
  - name: 全球拦截
    type: ss
    server: 127.0.0.1
    port: 8399
    cipher: aes-128-gcm
    password: pass
  - name: 电信 日本 02
    type: ss
    server: 127.0.0.1
    port: 8390
    cipher: aes-128-gcm
    password: pass
`
    });
    const config = parse(yamlText);

    expect(config.proxies.map((proxy: { name: string }) => proxy.name)).toEqual([
      '中国移动 香港 01',
      '电信 日本 02'
    ]);
    expect(config['proxy-groups'][0].proxies).toEqual(
      expect.arrayContaining(['中国移动 香港 01', '电信 日本 02'])
    );
    expect(config['proxy-groups'][0].proxies).not.toContain('中国联通 订阅地址');
    expect(config['proxy-groups'][0].proxies).not.toContain('中国移动 剩余流量 100 GB');
    expect(config['proxy-groups'][0].proxies).not.toContain('联通移动用中转，电信移动cf');
    expect(config['proxy-groups'][0].proxies).not.toContain('HK 丛雨云');
    expect(config['proxy-groups'][0].proxies).not.toContain('日本 全部超时 01');
    expect(config['proxy-groups'][0].proxies).not.toContain('twcongyu.org 🐱');
    expect(config['proxy-groups'][0].proxies).not.toContain('全球直连');
    expect(config['proxy-groups'][0].proxies).not.toContain('节点选择');
    expect(config['proxy-groups'][0].proxies).not.toContain('全球拦截');
    expect(config['proxy-groups'][1].proxies).not.toContain('自动选择');
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
  fake-ip-filter:
    - geosite:private
    - geosite:cn
    - +.lan
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
      - 剩余流量：796.81 GB
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
    expect(config.dns['fake-ip-filter']).toEqual(['+.lan']);
    expect(config.proxies.map((proxy: { name: string }) => proxy.name)).toEqual(['HK 01']);
    expect(config['proxy-groups'][0].proxies).toEqual(['HK 01']);
    expect(config.rules).toEqual(
      expect.arrayContaining([
        'DOMAIN-SUFFIX,weixin.qq.com,DIRECT',
        'DOMAIN-SUFFIX,douyin.com,DIRECT',
        'DOMAIN-SUFFIX,xiaohongshu.com,DIRECT',
        'PROCESS-NAME,Steam.exe,PROXY',
        'DOMAIN-SUFFIX,flow.google.com,PROXY',
        'DOMAIN-SUFFIX,steampowered.com,PROXY',
        'DOMAIN-SUFFIX,api.steampowered.com,PROXY',
        'DOMAIN-SUFFIX,steamcommunity.com,PROXY',
        'DOMAIN-SUFFIX,steamcdn-a.akamaihd.net,PROXY',
        'DOMAIN-SUFFIX,steamstore-a.akamaihd.net,PROXY',
        'DOMAIN-SUFFIX,steamuserimages-a.akamaihd.net,PROXY',
        'DOMAIN-SUFFIX,steamcloud-ugc.storage.googleapis.com,PROXY'
      ])
    );
    expect(config.rules.indexOf('DOMAIN-SUFFIX,weixin.qq.com,DIRECT')).toBeLessThan(
      config.rules.indexOf('DOMAIN-SUFFIX,flow.google.com,PROXY')
    );
    expect(config.rules).toContain('DOMAIN-SUFFIX,example.com,PROXY');
    expect(config.rules).toContain('MATCH,DIRECT');
    expect(config.rules).not.toContain('GEOSITE,cn,DIRECT');
    expect(config.rules).not.toContain('GEOIP,CN,DIRECT');
  });

  it('promotes subscription direct rules before subscription proxy rules', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'subscription',
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
  - RULE-SET,proxy,PROXY
  - RULE-SET,gfw,PROXY
  - RULE-SET,tld-not-cn,PROXY
  - RULE-SET,direct,DIRECT
  - RULE-SET,cncidr,DIRECT,no-resolve
  - DOMAIN-SUFFIX,sufe.uk,DIRECT
  - MATCH,PROXY
`
    });
    const config = parse(yamlText);

    expect(config.rules).toContain('DOMAIN-SUFFIX,weixin.qq.com,DIRECT');
    expect(config.rules).toContain('DOMAIN-SUFFIX,douyin.com,DIRECT');
    expect(config.rules.indexOf('DOMAIN-SUFFIX,weixin.qq.com,DIRECT')).toBeLessThan(
      config.rules.indexOf('RULE-SET,proxy,PROXY')
    );
    expect(config.rules.indexOf('RULE-SET,direct,DIRECT')).toBeLessThan(
      config.rules.indexOf('RULE-SET,proxy,PROXY')
    );
    expect(config.rules.indexOf('RULE-SET,cncidr,DIRECT,no-resolve')).toBeLessThan(
      config.rules.indexOf('RULE-SET,gfw,PROXY')
    );
    expect(config.rules.indexOf('DOMAIN-SUFFIX,sufe.uk,DIRECT')).toBeLessThan(
      config.rules.indexOf('RULE-SET,tld-not-cn,PROXY')
    );
    expect(config.rules.at(-1)).toBe('MATCH,PROXY');
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
