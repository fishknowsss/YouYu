import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildMihomoConfig } from '../../src/main/mihomo/config';

const expectedMicrosoftStoreDirectDomains = [
  'apps.microsoft.com',
  'mp.microsoft.com',
  'delivery.mp.microsoft.com',
  'storeedgefd.dsx.mp.microsoft.com',
  'displaycatalog.mp.microsoft.com',
  'purchase.mp.microsoft.com',
  'licensing.mp.microsoft.com',
  'dl.delivery.mp.microsoft.com',
  'tlu.dl.delivery.mp.microsoft.com',
  'fe3.delivery.mp.microsoft.com',
  'store-images.s-microsoft.com',
  'store-images.microsoft.com',
  'storecatalogrevocation.storequality.microsoft.com',
  'sls.update.microsoft.com',
  'login.live.com',
  'login.microsoftonline.com',
  'windowsupdate.com',
  'update.microsoft.com',
  'xboxlive.com',
  'xboxservices.com',
  'assets1.xboxlive.com',
  'assets2.xboxlive.com'
];

describe('buildMihomoConfig', () => {
  it('builds a ruleset mihomo config with service groups and local direct safeguards', () => {
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
    expect(config['disable-keep-alive']).toBe(false);
    expect(config['keep-alive-idle']).toBe(30);
    expect(config['keep-alive-interval']).toBe(15);
    expect(config['proxy-providers'].airport.url).toBe('https://example.com/sub?token=secret');
    expect(config['proxy-providers'].airport.interval).toBe(43200);
    expect(config['proxy-providers'].airport['size-limit']).toBe(8 * 1024 * 1024);
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('剩余流量');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('中转');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('cloudflare');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('congyu\\.org');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('全球直连');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('节点选择');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('自动选择');
    expect(config['proxy-providers'].airport['exclude-filter']).toContain('全球拦截');
    expect(config['proxy-providers'].airport['health-check'].interval).toBe(1800);
    expect(config['proxy-providers'].airport['health-check']['expected-status']).toBe(204);
    expect(config['rule-providers']).toMatchObject({
      OpenAI: expect.objectContaining({ behavior: 'classical', 'size-limit': 32 * 1024 * 1024 }),
      Discord: expect.objectContaining({ behavior: 'classical', 'size-limit': 32 * 1024 * 1024 }),
      GitHub: expect.objectContaining({ behavior: 'classical', 'size-limit': 32 * 1024 * 1024 }),
      Microsoft: expect.objectContaining({ behavior: 'classical', 'size-limit': 32 * 1024 * 1024 })
    });
    expect(config['proxy-groups'].map((group: { name: string }) => group.name)).toEqual(
      expect.arrayContaining(['节点选择', '自动选择', '故障转移', '负载均衡', 'AI', 'Discord', '开发平台', '验证码'])
    );
    expect(config['proxy-groups'][1]).toMatchObject({
      type: 'url-test',
      interval: 1800,
      tolerance: 150,
      'expected-status': 204
    });
    expect(
      config['proxy-groups']
        .filter((group: { url?: string }) => Boolean(group.url))
        .every((group: { 'expected-status'?: number }) => group['expected-status'] === 204)
    ).toBe(true);
    expect(config.dns).toBeUndefined();
    expect(config.tun).toBeUndefined();
    expect(config.sniffer.enable).toBe(true);
    expect(config.rules[0]).toBe('PROCESS-NAME,ToDesk.exe,DIRECT');
    expect(config.rules).toEqual(
      expect.arrayContaining([
        `PROCESS-NAME,Steam.exe,${selector}`,
        `PROCESS-NAME,steamwebhelper.exe,${selector}`,
        `DOMAIN-SUFFIX,openai.com,${selector}`,
        `DOMAIN-SUFFIX,flow.google.com,${selector}`,
        `DOMAIN-SUFFIX,steampowered.com,${selector}`,
        `DOMAIN-SUFFIX,api.steampowered.com,${selector}`,
        `DOMAIN-SUFFIX,steamcommunity.com,${selector}`,
        `DOMAIN-SUFFIX,steamcdn-a.akamaihd.net,${selector}`,
        `DOMAIN-SUFFIX,steamcloud-ugc.storage.googleapis.com,${selector}`,
        'PROCESS-NAME,WinStore.App.exe,DIRECT',
        'PROCESS-NAME,StorePurchaseApp.exe,DIRECT',
        'PROCESS-NAME,AppInstaller.exe,DIRECT',
        'DOMAIN-SUFFIX,apps.microsoft.com,DIRECT',
        'DOMAIN-SUFFIX,mp.microsoft.com,DIRECT',
        'DOMAIN-SUFFIX,delivery.mp.microsoft.com,DIRECT',
        'DOMAIN-SUFFIX,store-images.s-microsoft.com,DIRECT',
        'DOMAIN-SUFFIX,xboxlive.com,DIRECT',
        'PROCESS-NAME,WeChat.exe,DIRECT',
        'PROCESS-NAME,DingTalk.exe,DIRECT',
        'RULE-SET,OpenAI,AI',
        'RULE-SET,Discord,Discord',
        'RULE-SET,GitHub,开发平台',
        'RULE-SET,Microsoft,微软服务',
        'RULE-SET,China,DIRECT',
        `MATCH,${selector}`
      ])
    );
    expect(config.rules.some((rule: string) => rule.startsWith('GEOIP,'))).toBe(false);
  });

  it('keeps built-in safeguards while ignoring deprecated remote rule lists', () => {
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
    expect(config.rules).not.toContain('DOMAIN-SUFFIX,remote.example.com,DIRECT');
    expect(config.rules).not.toContain(`DOMAIN-SUFFIX,ai.example.com,${selector}`);
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
        '*.msftconnecttest.com',
        '*.steampowered.com',
        'steamcdn-a.akamaihd.net',
        'steamcloud-ugc.storage.googleapis.com',
        'stun.*.*'
      ])
    );
    for (const domain of expectedMicrosoftStoreDirectDomains) {
      expect(config.dns['fake-ip-filter']).toContain(domain);
      expect(config.dns['fake-ip-filter']).toContain(`*.${domain}`);
    }
    expect(config.dns.nameserver).toEqual(['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query']);
    expect(config.dns['cache-algorithm']).toBe('arc');
    expect(config.dns['prefer-h3']).toBe(false);
    expect(config.dns['nameserver-policy']['+.steampowered.com']).toEqual([
      'https://1.1.1.1/dns-query#RULES',
      'https://8.8.8.8/dns-query#RULES'
    ]);
    expect(config.dns['nameserver-policy']['+.chatgpt.com']).toEqual([
      'https://1.1.1.1/dns-query#RULES',
      'https://8.8.8.8/dns-query#RULES'
    ]);
    expect(config.dns['nameserver-policy']['+.openai.com']).toEqual([
      'https://1.1.1.1/dns-query#RULES',
      'https://8.8.8.8/dns-query#RULES'
    ]);
    expect(config.dns['nameserver-policy']['+.steamcloud-ugc.storage.googleapis.com']).toEqual([
      'https://1.1.1.1/dns-query#RULES',
      'https://8.8.8.8/dns-query#RULES'
    ]);
    expect(config.dns['proxy-server-nameserver']).toEqual([
      'https://dns.alidns.com/dns-query',
      'https://doh.pub/dns-query'
    ]);
    expect(config.dns['respect-rules']).toBe(true);
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
      tolerance: 150,
      'expected-status': 204
    });
    expect(
      config['proxy-groups']
        .filter((group: { url?: string }) => Boolean(group.url))
        .every((group: { 'expected-status'?: number }) => group['expected-status'] === 204)
    ).toBe(true);
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

    expect(config.proxies.map((proxy: { name: string }) => proxy.name)).toEqual(['中国移动 香港 01', '电信 日本 02']);
    expect(config['proxy-groups'][0].proxies).toEqual(expect.arrayContaining(['中国移动 香港 01', '电信 日本 02']));
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

  it('preserves subscription routing while enforcing local runtime controls', () => {
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
    expect(config.dns).toBeUndefined();
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

  it('targets the first usable inline proxy when a full subscription has rules but no routable group', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'subscription',
      subscriptionConfigText: `
proxies:
  - name: Traffic remaining 100 GB
    type: ss
    server: 127.0.0.1
    port: 8387
    cipher: aes-128-gcm
    password: notice
  - name: HK 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
rules:
  - DOMAIN-SUFFIX,example.com,HK 01
  - MATCH,HK 01
`
    });
    const config = parse(yamlText);

    expect(config.proxies.map((proxy: { name: string }) => proxy.name)).toEqual(['HK 01']);
    expect(config['proxy-groups']).toBeUndefined();
    expect(config.rules).toContain('DOMAIN-SUFFIX,flow.google.com,HK 01');
    expect(config.rules).toContain('MATCH,HK 01');
  });

  it('skips whitespace-padded inline proxy names when selecting a fallback routing target', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'subscription',
      subscriptionConfigText: `
proxies:
  - name: '  HK 01  '
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: HK 02
    type: ss
    server: 127.0.0.1
    port: 8389
    cipher: aes-128-gcm
    password: pass
rules:
  - MATCH,HK 02
`
    });
    const config = parse(yamlText);

    expect(config.proxies[0].name).toBe('  HK 01  ');
    expect(config.rules).toContain('DOMAIN-SUFFIX,flow.google.com,HK 02');
  });

  it('falls back to the managed provider when every inline proxy name has edge whitespace', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/canonical-subscription',
      secret: 'local-secret',
      ruleProfile: 'subscription',
      subscriptionConfigText: `
proxies:
  - name: '  HK 01  '
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
rules:
  - 'MATCH,  HK 01  '
`
    });
    const config = parse(yamlText);

    expect(config.proxies).toBeUndefined();
    expect(config['proxy-providers'].airport.url).toBe('https://example.com/canonical-subscription');
  });

  it('falls back to the managed provider config when provider-only subscription rules have no routable group', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/canonical-subscription',
      secret: 'local-secret',
      ruleProfile: 'subscription',
      subscriptionConfigText: `
proxy-providers:
  untrusted:
    type: http
    url: https://example.com/untrusted-provider
    path: ./providers/untrusted.yaml
rules:
  - MATCH,PROXY
`
    });
    const config = parse(yamlText);

    expect(config['proxy-providers'].airport.url).toBe('https://example.com/canonical-subscription');
    expect(config['proxy-providers'].untrusted).toBeUndefined();
    expect(config['proxy-groups']).not.toHaveLength(0);
    expect(config.rules.at(-1)).toBe(`MATCH,${config['proxy-groups'][0].name}`);
  });

  it('keeps only client routing capabilities from an untrusted full subscription', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'subscription',
      mixedPort: 7991,
      controllerPort: 9191,
      allowLan: false,
      dnsEnhanced: false,
      snifferEnabled: false,
      tunEnabled: false,
      subscriptionConfigText: String.raw`
port: 7890
mixed-port: 7891
allow-lan: true
bind-address: 0.0.0.0
authentication: [attacker:secret]
skip-auth-prefixes: [0.0.0.0/0]
lan-allowed-ips: [0.0.0.0/0]
lan-disallowed-ips: []
listeners:
  - name: attacker-http
    type: http
    port: 18080
    listen: 0.0.0.0
tunnels:
  - tcp,0.0.0.0:17777,example.com:443,PROXY
ss-config:
  listen: 0.0.0.0:18388
vmess-config:
  listen: 0.0.0.0:18389
tuic-server:
  listen: 0.0.0.0:18390
external-controller: 0.0.0.0:19090
external-controller-unix: attacker.sock
external-controller-pipe: '\\.\pipe\attacker'
external-controller-tls: 0.0.0.0:19443
external-controller-cors:
  allow-origins: ['*']
external-doh-server: /dns-query
external-ui: C:\\attacker-ui
external-ui-name: attacker
external-ui-url: https://example.com/attacker-ui.zip
tls:
  certificate: C:\\attacker.crt
  private-key: C:\\attacker.key
dns:
  enable: true
  listen: 0.0.0.0:15353
sniffer:
  enable: true
tun:
  enable: true
  auto-route: true
future-inbound:
  listen: 0.0.0.0:19999
proxies:
  - name: HK 01
    type: ss
    server: 127.0.0.1
    port: 8388
    cipher: aes-128-gcm
    password: pass
proxy-providers:
  backup:
    type: http
    url: https://example.com/provider
    path: ./providers/backup.yaml
proxy-groups:
  - name: PROXY
    type: select
    proxies: [HK 01]
rule-providers:
  SafeRules:
    type: http
    behavior: classical
    url: https://example.com/rules.yaml
    path: ./rulesets/safe.yaml
sub-rules:
  safe-sub-rule:
    - DOMAIN-SUFFIX,example.net,PROXY
rules:
  - RULE-SET,SafeRules,PROXY
  - SUB-RULE,(NETWORK,tcp),safe-sub-rule
  - MATCH,PROXY
`
    });
    const config = parse(yamlText);

    expect(config['mixed-port']).toBe(7991);
    expect(config['allow-lan']).toBe(false);
    expect(config['external-controller']).toBe('127.0.0.1:9191');
    expect(config.secret).toBe('local-secret');
    expect(config.dns).toBeUndefined();
    expect(config.sniffer).toBeUndefined();
    expect(config.tun).toBeUndefined();
    expect(config.proxies).toHaveLength(1);
    expect(config['proxy-providers'].backup).toMatchObject({
      url: 'https://example.com/provider',
      interval: 12 * 60 * 60,
      'size-limit': 8 * 1024 * 1024
    });
    expect(config['proxy-groups'][0].name).toBe('PROXY');
    expect(config['rule-providers'].SafeRules).toMatchObject({
      url: 'https://example.com/rules.yaml',
      interval: 24 * 60 * 60,
      'size-limit': 32 * 1024 * 1024
    });
    expect(config['sub-rules']['safe-sub-rule']).toEqual(['DOMAIN-SUFFIX,example.net,PROXY']);
    expect(config.rules).toEqual(
      expect.arrayContaining(['RULE-SET,SafeRules,PROXY', 'SUB-RULE,(NETWORK,tcp),safe-sub-rule'])
    );

    for (const key of [
      'port',
      'bind-address',
      'authentication',
      'skip-auth-prefixes',
      'lan-allowed-ips',
      'lan-disallowed-ips',
      'listeners',
      'tunnels',
      'ss-config',
      'vmess-config',
      'tuic-server',
      'external-controller-unix',
      'external-controller-pipe',
      'external-controller-tls',
      'external-controller-cors',
      'external-doh-server',
      'external-ui',
      'external-ui-name',
      'external-ui-url',
      'tls',
      'future-inbound'
    ]) {
      expect(config[key]).toBeUndefined();
    }
  });

  it('secures provider health checks without changing subscription endpoints', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'subscription',
      subscriptionConfigText: `
proxy-providers:
  airport:
    type: http
    url: http://example.com/subscription.yaml
    path: ./providers/airport.yaml
    health-check:
      enable: true
      url: http://1.1.1.1/generate_204
      expected-status: 200
  backup:
    type: http
    url: https://example.com/backup.yaml
    path: ./providers/backup.yaml
    health-check:
      enable: true
      url: http://www.gstatic.com/generate_204
proxy-groups:
  - name: PROXY
    type: select
    use:
      - airport
      - backup
rules:
  - MATCH,PROXY
`
    });
    const config = parse(yamlText);
    const provider = config['proxy-providers'].airport;

    expect(provider.url).toBe('http://example.com/subscription.yaml');
    expect(provider['health-check']).toMatchObject({
      enable: true,
      url: 'https://cp.cloudflare.com/generate_204',
      'expected-status': 204
    });
    expect(config['proxy-providers'].backup).toMatchObject({
      url: 'https://example.com/backup.yaml',
      'health-check': {
        enable: true,
        url: 'https://www.gstatic.com/generate_204',
        'expected-status': 204
      }
    });
  });

  it('bounds only HTTP provider downloads, refreshes, and health checks', () => {
    const yamlText = buildMihomoConfig({
      subscriptionUrl: 'https://example.com/sub',
      secret: 'local-secret',
      ruleProfile: 'subscription',
      subscriptionConfigText: `
proxy-providers:
  malicious:
    type: http
    url: https://example.com/malicious.yaml
    path: ./providers/malicious.yaml
    size-limit: 0
    interval: 1
    health-check:
      enable: true
      url: https://status.example.com/ping
      interval: 1
      timeout: 999999
      lazy: false
  oversized:
    type: http
    url: https://example.com/oversized.yaml
    path: ./providers/oversized.yaml
    size-limit: 999999999
    interval: 999999999
    health-check:
      enable: true
      url: https://status.example.com/ping
      interval: 999999999
      timeout: 0
      lazy: false
  normal:
    type: http
    url: https://example.com/normal.yaml
    path: ./providers/normal.yaml
    size-limit: 1048576
    interval: 7200
    health-check:
      enable: true
      url: https://status.example.com/ping
      interval: 600
      timeout: 2500
      lazy: false
  local:
    type: file
    path: ./providers/local.yaml
    size-limit: 0
    interval: 1
    health-check:
      enable: true
      interval: 1
      timeout: 999999
      lazy: false
proxy-groups:
  - name: MALICIOUS-GROUP
    type: url-test
    use: [malicious]
    url: https://status.example.com/ping
    interval: 1
    timeout: 999999
    lazy: false
  - name: OVERSIZED-GROUP
    type: load-balance
    use: [oversized]
    url: https://status.example.com/ping
    interval: 999999999
    timeout: 0
    lazy: false
  - name: NORMAL-GROUP
    type: fallback
    use: [normal]
    url: https://status.example.com/ping
    interval: 600
    timeout: 2500
    lazy: false
  - name: PROXY
    type: select
    use: [malicious, oversized, normal, local]
    url: https://status.example.com/ping
    interval: 1
    timeout: 999999
    lazy: false
rule-providers:
  malicious-rules:
    type: http
    behavior: classical
    url: https://example.com/malicious-rules.yaml
    path: ./rulesets/malicious.yaml
    size-limit: 0
    interval: 1
  oversized-rules:
    type: http
    behavior: classical
    url: https://example.com/oversized-rules.yaml
    path: ./rulesets/oversized.yaml
    size-limit: 999999999
    interval: 999999999
  normal-rules:
    type: http
    behavior: classical
    url: https://example.com/normal-rules.yaml
    path: ./rulesets/normal.yaml
    size-limit: 1048576
    interval: 7200
  inline-rules:
    type: inline
    behavior: classical
    size-limit: 0
    interval: 1
    payload:
      - DOMAIN-SUFFIX,inline.example.com
rules:
  - RULE-SET,malicious-rules,PROXY
  - MATCH,PROXY
`
    });
    const config = parse(yamlText);
    const proxyProviders = config['proxy-providers'];
    const ruleProviders = config['rule-providers'];
    const proxyGroups = Object.fromEntries(
      config['proxy-groups'].map((group: { name: string }) => [group.name, group])
    );

    expect(proxyGroups['MALICIOUS-GROUP']).toMatchObject({ interval: 300, timeout: 10_000, lazy: true });
    expect(proxyGroups['OVERSIZED-GROUP']).toMatchObject({ interval: 24 * 60 * 60, timeout: 1000, lazy: true });
    expect(proxyGroups['NORMAL-GROUP']).toMatchObject({ interval: 600, timeout: 2500, lazy: true });
    expect(proxyGroups.PROXY).toMatchObject({ type: 'select', interval: 1, timeout: 999999, lazy: false });

    expect(proxyProviders.malicious).toMatchObject({
      'size-limit': 8 * 1024 * 1024,
      interval: 3600,
      'health-check': { interval: 300, timeout: 10_000, lazy: true }
    });
    expect(proxyProviders.oversized).toMatchObject({
      'size-limit': 8 * 1024 * 1024,
      interval: 7 * 24 * 60 * 60,
      'health-check': { interval: 24 * 60 * 60, timeout: 1000, lazy: true }
    });
    expect(proxyProviders.normal).toMatchObject({
      'size-limit': 1024 * 1024,
      interval: 7200,
      'health-check': { interval: 600, timeout: 2500, lazy: true }
    });
    expect(proxyProviders.local).toMatchObject({
      type: 'file',
      'size-limit': 0,
      interval: 1,
      'health-check': { interval: 1, timeout: 999999, lazy: false }
    });

    expect(ruleProviders['malicious-rules']).toMatchObject({
      'size-limit': 32 * 1024 * 1024,
      interval: 3600
    });
    expect(ruleProviders['oversized-rules']).toMatchObject({
      'size-limit': 32 * 1024 * 1024,
      interval: 7 * 24 * 60 * 60
    });
    expect(ruleProviders['normal-rules']).toMatchObject({ 'size-limit': 1024 * 1024, interval: 7200 });
    expect(ruleProviders['inline-rules']).toMatchObject({ type: 'inline', 'size-limit': 0, interval: 1 });
  });

  it('secures known group health checks without changing custom HTTPS checks', () => {
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
  - name: AUTO
    type: url-test
    url: http://www.gstatic.com/generate_204
    expected-status: 200
    proxies:
      - HK 01
  - name: CUSTOM
    type: fallback
    url: https://status.example.com/ping
    expected-status: 200
    proxies:
      - HK 01
  - name: CLOUDFLARE
    type: load-balance
    url: http://1.1.1.1/generate_204
    expected-status: 200
    proxies:
      - HK 01
rules:
  - MATCH,AUTO
`
    });
    const config = parse(yamlText);

    expect(config['proxy-groups'][0]).toMatchObject({
      name: 'AUTO',
      url: 'https://www.gstatic.com/generate_204',
      'expected-status': 204
    });
    expect(config['proxy-groups'][1]).toMatchObject({
      name: 'CUSTOM',
      url: 'https://status.example.com/ping',
      'expected-status': 200
    });
    expect(config['proxy-groups'][2]).toMatchObject({
      name: 'CLOUDFLARE',
      url: 'https://cp.cloudflare.com/generate_204',
      'expected-status': 204
    });
  });

  it('uses YouYu rulesets for full airport configs by default without removing airport nodes', () => {
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

    expect(config.proxies.map((proxy: { name: string }) => proxy.name)).toEqual(['HK 01']);
    expect(config['proxy-groups'].map((group: { name: string }) => group.name)).toEqual(
      expect.arrayContaining(['PROXY', 'AI', 'Discord', '开发平台', '验证码', '微软服务'])
    );
    expect(config['rule-providers']).toMatchObject({
      OpenAI: expect.objectContaining({ proxy: 'PROXY' }),
      GitHub: expect.objectContaining({ proxy: 'PROXY' }),
      Discord: expect.objectContaining({ proxy: 'PROXY' })
    });
    expect(config.rules).toEqual(
      expect.arrayContaining([
        'PROCESS-NAME,ToDesk.exe,DIRECT',
        'RULE-SET,OpenAI,AI',
        'RULE-SET,Discord,Discord',
        'RULE-SET,GitHub,开发平台',
        'RULE-SET,China,DIRECT',
        'MATCH,PROXY'
      ])
    );
    expect(config.rules).not.toContain('DOMAIN-SUFFIX,example.com,DIRECT');
    expect(config.rules).not.toContain('MATCH,DIRECT');
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
    expect(config.rules.indexOf('RULE-SET,direct,DIRECT')).toBeLessThan(config.rules.indexOf('RULE-SET,proxy,PROXY'));
    expect(config.rules.indexOf('RULE-SET,cncidr,DIRECT,no-resolve')).toBeLessThan(
      config.rules.indexOf('RULE-SET,gfw,PROXY')
    );
    expect(config.rules.indexOf('DOMAIN-SUFFIX,sufe.uk,DIRECT')).toBeLessThan(
      config.rules.indexOf('RULE-SET,tld-not-cn,PROXY')
    );
    expect(config.rules.at(-1)).toBe('MATCH,PROXY');
  });

  it('falls back to built-in routing when an airport config has no rules', () => {
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
`
    });
    const config = parse(yamlText);

    expect(config.rules).toContain('DOMAIN-SUFFIX,flow.google.com,PROXY');
    expect(config.rules).toContain('DOMAIN-SUFFIX,cn,DIRECT');
    expect(config.rules).toContain('MATCH,PROXY');
  });
});
