import YAML from 'yaml';
import type { MihomoMode, RuleProfile, StrategyKey } from '../../shared/ipc';

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
  if (input.ruleProfile === 'subscription' && input.subscriptionConfigText) {
    const subscriptionConfig = buildSubscriptionConfig(input);
    if (subscriptionConfig) {
      return subscriptionConfig;
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
      'default-nameserver': ['223.5.5.5', '119.29.29.29', '1.1.1.1'],
      nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
      fallback: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query']
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

    const merged = {
      ...config,
      ...buildRuntimeOptions(input)
    };

    if (!Array.isArray(merged.rules) || merged.rules.length === 0) {
      merged.rules = buildManagedRules('smart');
    }

    return YAML.stringify(merged);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
