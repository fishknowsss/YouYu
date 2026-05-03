import YAML from 'yaml';
import type { MihomoMode, RuleProfile, StrategyKey } from '../../shared/ipc';

const preferredDefaultNodeKeywords = ['日本', '09', '家宽'];
const noticeNodeKeywords = ['失去支持', '更新你的代理客户端', '官网公告', '代理客户端'];

export type MihomoConfigInput = {
  subscriptionUrl: string;
  secret: string;
  mode?: MihomoMode;
  strategy?: StrategyKey;
  ruleProfile?: RuleProfile;
  systemProxyEnabled?: boolean;
  dnsEnhanced?: boolean;
  snifferEnabled?: boolean;
  tunEnabled?: boolean;
  allowLan?: boolean;
  subscriptionConfigText?: string;
  mixedPort?: number;
  controllerPort?: number;
  dnsPort?: number;
};

export function buildMihomoConfig(input: MihomoConfigInput): string {
  if (input.subscriptionConfigText) {
    const subscriptionConfig = buildSubscriptionConfig(input);
    if (subscriptionConfig) {
      return subscriptionConfig;
    }
  }

  if (input.subscriptionConfigText) {
    const inlineConfig = buildInlineSubscriptionConfig(input);
    if (inlineConfig) {
      return inlineConfig;
    }
  }

  const config = {
    ...buildRuntimeOptions(input),
    'proxy-providers': {
      airport: {
        type: 'http',
        url: input.subscriptionUrl,
        path: './providers/airport.yaml',
        interval: 43200,
        'health-check': {
          enable: true,
          url: 'https://www.gstatic.com/generate_204',
          interval: 300,
          timeout: 5000,
          lazy: true
        }
      }
    },
    'proxy-groups': [
      {
        name: '节点选择',
        type: 'select',
        use: ['airport'],
        proxies: ['自动选择', '故障转移', '负载均衡', 'DIRECT']
      },
      {
        name: '自动选择',
        type: 'url-test',
        use: ['airport'],
        url: 'https://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 50,
        lazy: true
      },
      {
        name: '故障转移',
        type: 'fallback',
        use: ['airport'],
        url: 'https://www.gstatic.com/generate_204',
        interval: 300,
        lazy: true
      },
      {
        name: '负载均衡',
        type: 'load-balance',
        strategy: 'consistent-hashing',
        use: ['airport'],
        url: 'https://www.gstatic.com/generate_204',
        interval: 300,
        lazy: true
      }
    ],
    rules: buildManagedRules(input.ruleProfile ?? 'smart')
  };

  return YAML.stringify(config);
}

function buildInlineSubscriptionConfig(input: MihomoConfigInput): string | null {
  try {
    const parsed = YAML.parse(input.subscriptionConfigText ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const proxies = (parsed as Record<string, unknown>).proxies;
    if (!Array.isArray(proxies) || proxies.length === 0) {
      return null;
    }

    const validProxies = proxies.filter((proxy) => {
      const name = isRecord(proxy) && typeof proxy.name === 'string' ? proxy.name : '';
      return Boolean(name) && !isNoticeNodeName(name);
    });
    const proxyNames = validProxies
      .map((proxy) => (isRecord(proxy) && typeof proxy.name === 'string' ? proxy.name : undefined))
      .filter((name): name is string => Boolean(name));
    if (proxyNames.length === 0) {
      return null;
    }
    const orderedProxyNames = orderProxyNames(proxyNames);

    const config = {
      ...buildRuntimeOptions(input),
      proxies: validProxies,
      'proxy-groups': [
        {
          name: '节点选择',
          type: 'select',
          proxies: ['自动选择', orderedProxyNames[0], '故障转移', '负载均衡', 'DIRECT', ...orderedProxyNames.slice(1)]
        },
        {
          name: '自动选择',
          type: 'url-test',
          proxies: orderedProxyNames,
          url: 'https://www.gstatic.com/generate_204',
          interval: 300,
          tolerance: 50,
          lazy: true
        },
        {
          name: '故障转移',
          type: 'fallback',
          proxies: orderedProxyNames,
          url: 'https://www.gstatic.com/generate_204',
          interval: 300,
          lazy: true
        },
        {
          name: '负载均衡',
          type: 'load-balance',
          proxies: orderedProxyNames,
          url: 'https://www.gstatic.com/generate_204',
          interval: 300,
          strategy: 'consistent-hashing',
          lazy: true
        }
      ],
      rules: buildManagedRules(input.ruleProfile ?? 'smart')
    };

    return YAML.stringify(config);
  } catch {
    return null;
  }
}

function isNoticeNodeName(name: string): boolean {
  return noticeNodeKeywords.some((keyword) => name.includes(keyword));
}

function orderProxyNames(proxyNames: string[]): string[] {
  const preferred = proxyNames.find((name) =>
    preferredDefaultNodeKeywords.every((keyword) => name.includes(keyword))
  );
  if (!preferred) {
    return proxyNames;
  }

  return [preferred, ...proxyNames.filter((name) => name !== preferred)];
}

export const strategyTargets: Record<Exclude<StrategyKey, 'manual'>, string> = {
  auto: '自动选择',
  fallback: '故障转移',
  'load-balance': '负载均衡',
  direct: 'DIRECT'
};

export const strategyLabels: Record<StrategyKey, string> = {
  manual: '手动',
  auto: '自动',
  fallback: '故障转移',
  'load-balance': '均衡',
  direct: '直连'
};

function buildRuntimeOptions(input: MihomoConfigInput) {
  const options: Record<string, unknown> = {
    'mixed-port': input.mixedPort ?? 7890,
    'allow-lan': input.allowLan ?? false,
    mode: input.mode ?? 'rule',
    'log-level': 'warning',
    'external-controller': `127.0.0.1:${input.controllerPort ?? 9090}`,
    secret: input.secret,
    ipv6: false,
    'unified-delay': true,
    'tcp-concurrent': true,
    'find-process-mode': 'strict',
    'geodata-mode': false,
    'geo-auto-update': false,
    'geodata-loader': 'memconservative',
    'global-ua': 'Clash Verge/2.3.2',
    profile: {
      'store-selected': true,
      'store-fake-ip': true
    }
  };

  if (input.dnsEnhanced ?? true) {
    options.dns = {
      enable: true,
      listen: `127.0.0.1:${input.dnsPort ?? 1053}`,
      ipv6: false,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'fake-ip-filter': [
        '*.lan',
        '*.local',
        'localhost.ptlogin2.qq.com',
        'dns.msftncsi.com',
        'www.msftconnecttest.com'
      ],
      'default-nameserver': ['223.5.5.5', '119.29.29.29'],
      nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query', '1.1.1.1']
    };
  }

  if (input.snifferEnabled ?? true) {
    options.sniffer = {
      enable: true,
      'parse-pure-ip': true,
      'force-dns-mapping': true,
      sniff: {
        HTTP: {
          ports: ['80', '8080-8880'],
          'override-destination': true
        },
        TLS: {
          ports: ['443', '8443']
        },
        QUIC: {
          ports: ['443', '8443']
        }
      }
    };
  }

  if (input.tunEnabled) {
    options.tun = {
      enable: true,
      stack: 'mixed',
      'dns-hijack': ['any:53'],
      'auto-route': true,
      'auto-detect-interface': true,
      'strict-route': false
    };
  }

  return options;
}

function buildManagedRules(ruleProfile: RuleProfile) {
  if (ruleProfile === 'global') {
    return ['MATCH,节点选择'];
  }

  return [
    'DOMAIN-SUFFIX,local,DIRECT',
    'DOMAIN-SUFFIX,localhost,DIRECT',
    'DOMAIN-SUFFIX,cn,DIRECT',
    'DOMAIN-SUFFIX,baidu.com,DIRECT',
    'DOMAIN-SUFFIX,qq.com,DIRECT',
    'DOMAIN-SUFFIX,weixin.qq.com,DIRECT',
    'DOMAIN-SUFFIX,bilibili.com,DIRECT',
    'DOMAIN-SUFFIX,taobao.com,DIRECT',
    'DOMAIN-SUFFIX,jd.com,DIRECT',
    'DOMAIN-SUFFIX,alicdn.com,DIRECT',
    'DOMAIN-SUFFIX,163.com,DIRECT',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
    'MATCH,节点选择'
  ];
}

function buildSubscriptionConfig(input: MihomoConfigInput): string | null {
  try {
    const parsed = YAML.parse(input.subscriptionConfigText ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const config = parsed as Record<string, unknown>;
    const hasProxySource = Array.isArray(config.proxies) || isRecord(config['proxy-providers']);
    const hasRouting = Array.isArray(config.rules) || Array.isArray(config['proxy-groups']);
    if (!hasProxySource || !hasRouting) {
      return null;
    }

    const runtimeOptions = buildRuntimeOptions(input);
    const merged = { ...config };
    removeSubscriptionListenerPorts(merged);
    Object.assign(merged, runtimeOptions);
    sanitizeDnsConfig(merged);

    if (!Array.isArray(merged.rules) || merged.rules.length === 0) {
      merged.rules = buildManagedRules('smart');
    } else {
      merged.rules = normalizeSubscriptionRules(merged.rules);
    }

    return YAML.stringify(merged);
  } catch {
    return null;
  }
}

function removeSubscriptionListenerPorts(config: Record<string, unknown>) {
  delete config.port;
  delete config['socks-port'];
  delete config['redir-port'];
  delete config['tproxy-port'];
  delete config['mixed-port'];
}

function normalizeSubscriptionRules(rules: unknown[]): unknown[] {
  return rules.filter((rule) => {
    if (typeof rule !== 'string') {
      return true;
    }

    const normalizedRule = rule.trim().toUpperCase();
    return !normalizedRule.startsWith('GEOIP,') && !normalizedRule.startsWith('GEOSITE,');
  });
}

function sanitizeDnsConfig(config: Record<string, unknown>) {
  if (!isRecord(config.dns)) {
    return;
  }

  delete config.dns.fallback;
  delete config.dns['fallback-filter'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
