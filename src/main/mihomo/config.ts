import YAML from 'yaml';
import type { MihomoMode, RemoteControlConfig, RuleProfile, StrategyKey } from '../../shared/ipc';

const selectorName = '节点选择';
const preferredDefaultNodeKeywords = ['台湾', '08', '家宽'];
const noticeNodeKeywords = [
  '失去支持',
  '更新你的代理客户端',
  '官网公告',
  '代理客户端',
  '剩余',
  '订阅',
  '官网',
  '丛雨云',
  '全部超时',
  'congyu.org'
];
const noticeNodePatterns = [
  /剩余流量[:：]/i,
  /剩余/i,
  /订阅/i,
  /距离下次重置/i,
  /重置剩余/i,
  /套餐到期/i,
  /官网地址/i,
  /官网/i,
  /(?:订阅|官网).*(?:地址|链接)|(?:地址|链接).*(?:订阅|官网)/i,
  /(?:联通|电信|移动).*(?:订阅|地址|官网|链接)|(?:订阅|地址|官网|链接).*(?:联通|电信|移动)/i,
  /失去支持/i,
  /更新.*客户端/i,
  /官网公告/i,
  /congyu\.org/i,
  /\b(?:traffic|remaining|subscription|subscribe|official|address|expire|reset)\b/i
];
const reservedSelectableNodeNames = new Set(['全球直连', '节点选择', '自动选择', '全球拦截']);
const carrierNodeKeywords = ['联通', '电信', '移动', 'unicom', 'telecom', 'mobile'];
const carrierTransitHintPattern = /(?:中转|cf|cloudflare|relay)/i;
const carrierTransitNoticePatterns = [
  /(?:联通|电信|移动|unicom|telecom|mobile).*(?:联通|电信|移动|unicom|telecom|mobile).*(?:中转|cf|cloudflare|relay)/i,
  /(?:中转|cf|cloudflare|relay).*(?:联通|电信|移动|unicom|telecom|mobile).*(?:联通|电信|移动|unicom|telecom|mobile)/i,
  /(?:联通|电信|移动).*(?:用|走|适合).*(?:中转|cf|cloudflare)/i,
  /(?:unicom|telecom|mobile).*(?:use|via|for).*(?:relay|cf|cloudflare)/i
];
const carrierNoticeHints = [
  '订阅',
  '官网',
  '地址',
  '链接',
  '公告',
  '剩余',
  '流量',
  '重置',
  '到期',
  '套餐',
  '失去支持',
  '客户端',
  '更新',
  '通知',
  'traffic',
  'remaining',
  'subscription',
  'subscribe',
  'official',
  'address',
  'expire',
  'reset'
];
const carrierOnlyNodePatterns = [/^(?:中国)?(?:联通|电信|移动)$/i, /^(?:china\s*)?(?:unicom|telecom|mobile)$/i];
const carrierTransitNoticeExcludeFilter =
  '(?:联通|电信|移动|unicom|telecom|mobile).*(?:联通|电信|移动|unicom|telecom|mobile).*(?:中转|cf|cloudflare|relay)|(?:中转|cf|cloudflare|relay).*(?:联通|电信|移动|unicom|telecom|mobile).*(?:联通|电信|移动|unicom|telecom|mobile)|(?:联通|电信|移动).*(?:用|走|适合).*(?:中转|cf|cloudflare)|(?:unicom|telecom|mobile).*(?:use|via|for).*(?:relay|cf|cloudflare)';
const carrierNoticeExcludeFilter =
  '(?:联通|电信|移动|unicom|telecom|mobile).*(?:订阅|官网|地址|链接|公告|剩余|流量|重置|到期|套餐|失去支持|客户端|更新|通知|traffic|remaining|subscription|subscribe|official|address|expire|reset)|(?:订阅|官网|地址|链接|公告|剩余|流量|重置|到期|套餐|失去支持|客户端|更新|通知|traffic|remaining|subscription|subscribe|official|address|expire|reset).*(?:联通|电信|移动|unicom|telecom|mobile)';
const noticeNodeExcludeFilter =
  `(?i)(剩余流量|剩余|订阅|官网|官网地址|订阅地址|订阅链接|距离下次重置|重置剩余|套餐到期|失去支持|更新.*客户端|丛雨云|全部超时|congyu\\.org|全球直连|节点选择|自动选择|全球拦截|traffic|remaining|subscription|subscribe|official|address|expire|reset|${carrierTransitNoticeExcludeFilter}|${carrierNoticeExcludeFilter})`;
const aiFlowDomains = [
  'flow.google.com',
  'labs.google',
  'google.com',
  'google',
  'googleapis.com',
  'googleusercontent.com',
  'gstatic.com',
  'ggpht.com',
  'googlevideo.com',
  'ytimg.com',
  'withgoogle.com',
  'firebaseapp.com',
  'firebaseio.com'
];
const steamAccelerationDomains = [
  'steampowered.com',
  'api.steampowered.com',
  'checkout.steampowered.com',
  'help.steampowered.com',
  'login.steampowered.com',
  'steamcommunity.com',
  'steamstatic.com',
  'steamcontent.com',
  'steamserver.net',
  'steam-chat.com',
  'steamgames.com',
  'steamusercontent.com',
  'valvesoftware.com',
  'cdn.cloudflare.steamstatic.com',
  'community.cloudflare.steamstatic.com',
  'store.cloudflare.steamstatic.com',
  'avatars.cloudflare.steamstatic.com',
  'clan.cloudflare.steamstatic.com',
  'shared.cloudflare.steamstatic.com',
  'steamcdn-a.akamaihd.net',
  'steamstore-a.akamaihd.net',
  'steamuserimages-a.akamaihd.net',
  'shared.akamai.steamstatic.com',
  'clan.akamai.steamstatic.com',
  'steamcloud-ugc.storage.googleapis.com',
  'steamcloud-eu-ams.storage.googleapis.com',
  'steamcloud-eu-fra.storage.googleapis.com',
  'steamcloud-eu.storage.googleapis.com',
  'steamcloud-finland.storage.googleapis.com',
  'steamcloud-saopaulo.storage.googleapis.com',
  'steamcloud-singapore.storage.googleapis.com',
  'steamcloud-sydney.storage.googleapis.com',
  'steamcloud-taiwan.storage.googleapis.com'
];
const gamingFakeIpFilterDomains = [
  '*.steampowered.com',
  '*.steamcommunity.com',
  '*.steamstatic.com',
  '*.steamcontent.com',
  '*.steamserver.net',
  '*.steam-chat.com',
  '*.steamgames.com',
  '*.steamusercontent.com',
  '*.valvesoftware.com',
  'steamcdn-a.akamaihd.net',
  'steamstore-a.akamaihd.net',
  'steamuserimages-a.akamaihd.net',
  '*.cloudflare.steamstatic.com',
  '*.akamai.steamstatic.com',
  'steamcloud-ugc.storage.googleapis.com',
  'steamcloud-eu-ams.storage.googleapis.com',
  'steamcloud-eu-fra.storage.googleapis.com',
  'steamcloud-eu.storage.googleapis.com',
  'steamcloud-finland.storage.googleapis.com',
  'steamcloud-saopaulo.storage.googleapis.com',
  'steamcloud-singapore.storage.googleapis.com',
  'steamcloud-sydney.storage.googleapis.com',
  'steamcloud-taiwan.storage.googleapis.com',
  'stun.*.*'
];
const steamProcessNames = [
  'Steam.exe',
  'steam.exe',
  'steamwebhelper.exe',
  'steamservice.exe',
  'steamerrorreporter.exe',
  'GameOverlayUI.exe'
];
const chinaDirectDomains = [
  'local',
  'localhost',
  'cn',
  '12306.cn',
  'gov.cn',
  'edu.cn',
  'baidu.com',
  'baidubce.com',
  'baidupcs.com',
  'bdstatic.com',
  'bcebos.com',
  'qq.com',
  'qpic.cn',
  'weixin.qq.com',
  'wechat.com',
  'tencent.com',
  'tencent-cloud.com',
  'tencentmeeting.com',
  'gtimg.com',
  'myqcloud.com',
  'qcloud.com',
  'alicdn.com',
  'aliyun.com',
  'alipay.com',
  'taobao.com',
  'tmall.com',
  'mmstat.com',
  'dingtalk.com',
  'jd.com',
  'jdl.com',
  '360buyimg.com',
  'pinduoduo.com',
  'yangkeduo.com',
  'bilibili.com',
  'hdslb.com',
  '163.com',
  '126.com',
  'netease.com',
  'music.163.com',
  'douyin.com',
  'douyinpic.com',
  'douyinstatic.com',
  'snssdk.com',
  'bytedance.com',
  'byteimg.com',
  'toutiao.com',
  'kuaishou.com',
  'ksapisrv.com',
  'xiaohongshu.com',
  'xhscdn.com',
  'meituan.com',
  'dianping.com',
  'amap.com',
  'autonavi.com',
  'mi.com',
  'xiaomi.com',
  'huawei.com',
  'hicloud.com',
  'honor.com',
  'oppo.com',
  'vivo.com',
  'iqiyi.com',
  'youku.com',
  'mgtv.com',
  'douban.com',
  'zhihu.com',
  'wps.cn',
  'kingsoft.com',
  'sogou.com',
  '360.cn',
  'gitee.com',
  'csdn.net',
  'feishu.cn',
  'larksuite.com',
  'sina.com.cn',
  'weibo.com'
];
const chinaDirectCidrs = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '255.255.255.255/32'
];
export const remoteDesktopProcessNames = [
  'ToDesk.exe',
  'ToDesk_Service.exe',
  'ToDesk_Lite.exe',
  'SunloginClient.exe',
  'SunloginClient_Desktop.exe',
  'SunloginService.exe',
  'AnyDesk.exe',
  'RustDesk.exe',
  'rustdesk.exe',
  'UU.exe',
  'UURemote.exe',
  'UUDesktop.exe',
  'UURemoteDesktop.exe',
  'UUAccelerator.exe',
  'NeteaseUU.exe'
];
const domesticDirectProcessNames = [
  'WeChat.exe',
  'Weixin.exe',
  'QQ.exe',
  'TIM.exe',
  'WXWork.exe',
  'WeCom.exe',
  'DingTalk.exe',
  'Feishu.exe',
  'Lark.exe',
  'TencentMeeting.exe',
  'wemeetapp.exe',
  'BaiduNetdisk.exe',
  'baidunetdisk.exe',
  'cloudmusic.exe',
  'QQMusic.exe',
  'Douyin.exe'
];
const builtInProxyNames = new Set(['COMPATIBLE', 'DIRECT', 'PASS', 'REJECT', 'REJECT-DROP']);
const routableProxyGroupTypes = new Set(['select', 'url-test', 'fallback', 'load-balance', 'relay']);
const nodeHealthCheckIntervalSeconds = 1800;
const autoSelectToleranceMs = 150;

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
  strictRouteEnabled?: boolean;
  allowLan?: boolean;
  subscriptionConfigText?: string;
  remoteConfig?: RemoteControlConfig;
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
        'exclude-filter': noticeNodeExcludeFilter,
        'health-check': {
          enable: true,
          url: 'https://www.gstatic.com/generate_204',
          interval: nodeHealthCheckIntervalSeconds,
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
        interval: nodeHealthCheckIntervalSeconds,
        tolerance: autoSelectToleranceMs,
        lazy: true
      },
      {
        name: '故障转移',
        type: 'fallback',
        use: ['airport'],
        url: 'https://www.gstatic.com/generate_204',
        interval: nodeHealthCheckIntervalSeconds,
        lazy: true
      },
      {
        name: '负载均衡',
        type: 'load-balance',
        strategy: 'consistent-hashing',
        use: ['airport'],
        url: 'https://www.gstatic.com/generate_204',
        interval: nodeHealthCheckIntervalSeconds,
        lazy: true
      }
    ],
    rules: buildManagedRules(input.ruleProfile ?? 'subscription', selectorName, input.remoteConfig)
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
      return Boolean(name) && !isBlockedSelectableNodeName(name);
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
          interval: nodeHealthCheckIntervalSeconds,
          tolerance: autoSelectToleranceMs,
          lazy: true
        },
        {
          name: '故障转移',
          type: 'fallback',
          proxies: orderedProxyNames,
          url: 'https://www.gstatic.com/generate_204',
          interval: nodeHealthCheckIntervalSeconds,
          lazy: true
        },
        {
          name: '负载均衡',
          type: 'load-balance',
          proxies: orderedProxyNames,
          url: 'https://www.gstatic.com/generate_204',
          interval: nodeHealthCheckIntervalSeconds,
          strategy: 'consistent-hashing',
          lazy: true
        }
      ],
      rules: buildManagedRules(input.ruleProfile ?? 'subscription', selectorName, input.remoteConfig)
    };

    return YAML.stringify(config);
  } catch {
    return null;
  }
}

export function isSubscriptionNoticeNodeName(name: string): boolean {
  return (
    isCarrierNoticeNodeName(name) ||
    noticeNodeKeywords.some((keyword) => name.includes(keyword)) ||
    noticeNodePatterns.some((pattern) => pattern.test(name))
  );
}

export function isReservedSelectableNodeName(name: string): boolean {
  return reservedSelectableNodeNames.has(name.trim());
}

export function isBlockedSelectableNodeName(name: string): boolean {
  return isSubscriptionNoticeNodeName(name) || isReservedSelectableNodeName(name);
}

function isCarrierNoticeNodeName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (carrierOnlyNodePatterns.some((pattern) => pattern.test(normalized))) return true;
  if (carrierTransitNoticePatterns.some((pattern) => pattern.test(normalized))) return true;

  const hasCarrier = carrierNodeKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
  if (!hasCarrier) return false;
  const carrierKeywordCount = carrierNodeKeywords.filter((keyword) => normalized.includes(keyword.toLowerCase())).length;
  if (carrierKeywordCount >= 2 && carrierTransitHintPattern.test(normalized)) return true;

  return carrierNoticeHints.some((hint) => normalized.includes(hint.toLowerCase()));
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

  if (input.dnsEnhanced === true) {
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
        'www.msftconnecttest.com',
        ...gamingFakeIpFilterDomains
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
      'dns-hijack': ['any:53', 'tcp://any:53'],
      'auto-route': true,
      'auto-detect-interface': true,
      'strict-route': input.strictRouteEnabled ?? true
    };
  }

  return options;
}

function buildManagedRules(
  ruleProfile: RuleProfile,
  proxyTarget = selectorName,
  remoteConfig?: RemoteControlConfig
) {
  const rulePrefix = buildRulePrefix(proxyTarget, remoteConfig);
  if (ruleProfile === 'global') {
    return dedupeRules([...rulePrefix, ...buildPriorityProxyRules(proxyTarget), `MATCH,${proxyTarget}`]);
  }

  return dedupeRules([
    ...rulePrefix,
    ...buildChinaDirectRules(),
    ...buildPriorityProxyRules(proxyTarget),
    `MATCH,${proxyTarget}`
  ]);
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
    sanitizeSubscriptionNoticeNodes(merged);

    const proxyTarget = findPrimaryProxyTarget(merged) ?? selectorName;
    merged.rules = buildRulesForFullSubscription(
      input.ruleProfile ?? 'subscription',
      merged.rules,
      proxyTarget,
      input.remoteConfig
    );

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

function sanitizeSubscriptionNoticeNodes(config: Record<string, unknown>) {
  const proxies = config.proxies;
  if (!Array.isArray(proxies)) {
    return;
  }

  const blockedProxyNames = new Set<string>();
  const filteredProxies = proxies.filter((proxy) => {
    const name = isRecord(proxy) && typeof proxy.name === 'string' ? proxy.name : '';
    const isBlocked = Boolean(name) && isBlockedSelectableNodeName(name);
    if (isBlocked) {
      blockedProxyNames.add(name);
    }
    return Boolean(name) && !isBlocked;
  });
  config.proxies = filteredProxies;

  if (!Array.isArray(config['proxy-groups'])) {
    return;
  }

  const proxyNames = new Set(
    filteredProxies
      .map((proxy) => (isRecord(proxy) && typeof proxy.name === 'string' ? proxy.name : undefined))
      .filter((name): name is string => Boolean(name))
  );
  const groupNames = new Set(
    config['proxy-groups']
      .map((group) => (isRecord(group) && typeof group.name === 'string' ? group.name : undefined))
      .filter((name): name is string => Boolean(name))
  );

  for (const group of config['proxy-groups']) {
    if (!isRecord(group) || !Array.isArray(group.proxies)) {
      continue;
    }

    group.proxies = group.proxies.filter((name) => {
      if (typeof name !== 'string') return true;
      const reservedGroupReference = isReservedSelectableNodeName(name) && groupNames.has(name);
      return (
        reservedGroupReference ||
        (!blockedProxyNames.has(name) &&
          !isBlockedSelectableNodeName(name) &&
          (proxyNames.has(name) || groupNames.has(name) || builtInProxyNames.has(name)))
      );
    });
  }
}

function normalizeSubscriptionRules(
  rules: unknown[],
  proxyTarget: string,
  remoteConfig?: RemoteControlConfig
): unknown[] {
  const buckets = splitSubscriptionRules(rules);
  return dedupeRules([
    ...buildRulePrefix(proxyTarget, remoteConfig),
    ...buildChinaDirectRules(),
    ...buildPriorityProxyRules(proxyTarget),
    ...buckets.reject,
    ...buckets.direct,
    ...buckets.other,
    ...buckets.match
  ]);
}

function buildRulesForFullSubscription(
  ruleProfile: RuleProfile,
  rules: unknown,
  proxyTarget: string,
  remoteConfig?: RemoteControlConfig
): unknown[] {
  if (ruleProfile === 'global') {
    return buildManagedRules('global', proxyTarget, remoteConfig);
  }

  if (ruleProfile === 'smart' || !Array.isArray(rules) || rules.length === 0) {
    return buildManagedRules('smart', proxyTarget, remoteConfig);
  }

  return normalizeSubscriptionRules(rules, proxyTarget, remoteConfig);
}

function sanitizeDnsConfig(config: Record<string, unknown>) {
  if (!isRecord(config.dns)) {
    return;
  }

  delete config.dns.fallback;
  delete config.dns['fallback-filter'];
  if (Array.isArray(config.dns['fake-ip-filter'])) {
    const fakeIpFilter = config.dns['fake-ip-filter'].filter((rule) => {
      return typeof rule !== 'string' || !rule.trim().toLowerCase().startsWith('geosite:');
    });
    if (fakeIpFilter.length > 0) {
      config.dns['fake-ip-filter'] = fakeIpFilter;
    } else {
      delete config.dns['fake-ip-filter'];
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildPriorityProxyRules(proxyTarget: string): string[] {
  return [
    ...steamProcessNames.map((name) => `PROCESS-NAME,${name},${proxyTarget}`),
    ...[...aiFlowDomains, ...steamAccelerationDomains].map((domain) => `DOMAIN-SUFFIX,${domain},${proxyTarget}`)
  ];
}

function buildRulePrefix(proxyTarget: string, remoteConfig?: RemoteControlConfig): string[] {
  return dedupeStringRules([
    ...buildRemoteDesktopDirectRules(),
    ...buildDomesticAppDirectRules(),
    ...normalizeRemoteRules(remoteConfig?.directRules, 'DIRECT'),
    ...normalizeRemoteRules(remoteConfig?.proxyRules, proxyTarget)
  ]);
}

function buildRemoteDesktopDirectRules(): string[] {
  return remoteDesktopProcessNames.map((name) => `PROCESS-NAME,${name},DIRECT`);
}

function buildDomesticAppDirectRules(): string[] {
  return domesticDirectProcessNames.map((name) => `PROCESS-NAME,${name},DIRECT`);
}

function buildChinaDirectRules(): string[] {
  return [
    ...chinaDirectDomains.map((domain) => `DOMAIN-SUFFIX,${domain},DIRECT`),
    ...chinaDirectCidrs.map((cidr) => `IP-CIDR,${cidr},DIRECT,no-resolve`)
  ];
}

function normalizeRemoteRules(rules: string[] | undefined, fallbackTarget: string): string[] {
  if (!rules?.length) return [];

  return rules
    .map((rule) => normalizeRemoteRule(rule, fallbackTarget))
    .filter((rule): rule is string => Boolean(rule));
}

function normalizeRemoteRule(rule: string, fallbackTarget: string): string | undefined {
  const parts = rule
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;

  const type = parts[0].toUpperCase();
  if (!['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'PROCESS-NAME'].includes(type)) {
    return undefined;
  }

  if (parts.length === 2) {
    return `${type},${parts[1]},${fallbackTarget}`;
  }

  const target = parts[2].toUpperCase() === 'PROXY' ? fallbackTarget : parts[2];
  const suffix = parts.slice(3);
  return [type, parts[1], target, ...suffix].join(',');
}

function isPriorityProxyRule(normalizedRule: string): boolean {
  const parts = normalizedRule.split(',').map((part) => part.trim().toLowerCase());
  if (parts.length < 2) {
    return false;
  }

  const [type, domain] = parts;
  if (type === 'process-name') {
    return steamProcessNames.map((name) => name.toLowerCase()).includes(domain);
  }

  return (
    (type === 'domain' || type === 'domain-suffix') &&
    [...aiFlowDomains, ...steamAccelerationDomains].includes(domain)
  );
}

function isManagedDirectRule(normalizedRule: string): boolean {
  const parts = normalizedRule.split(',').map((part) => part.trim().toLowerCase());
  if (parts.length < 3) return false;
  return parts[0] === 'process-name' && parts[2] === 'direct' && remoteDesktopProcessNames
    .map((name) => name.toLowerCase())
    .includes(parts[1]);
}

function splitSubscriptionRules(rules: unknown[]): {
  reject: unknown[];
  direct: unknown[];
  other: unknown[];
  match: unknown[];
} {
  const reject: unknown[] = [];
  const direct: unknown[] = [];
  const other: unknown[] = [];
  const match: unknown[] = [];

  for (const rule of rules) {
    if (typeof rule !== 'string') {
      other.push(rule);
      continue;
    }

    const trimmedRule = rule.trim();
    const normalizedRule = trimmedRule.toUpperCase();
    if (
      normalizedRule.startsWith('GEOIP,') ||
      normalizedRule.startsWith('GEOSITE,') ||
      isPriorityProxyRule(normalizedRule) ||
      isManagedDirectRule(normalizedRule)
    ) {
      continue;
    }

    const target = getRuleTarget(normalizedRule);
    if (normalizedRule.startsWith('MATCH,')) {
      match.push(trimmedRule);
    } else if (target === 'REJECT' || target === 'REJECT-DROP') {
      reject.push(trimmedRule);
    } else if (target === 'DIRECT') {
      direct.push(trimmedRule);
    } else {
      other.push(trimmedRule);
    }
  }

  return { reject, direct, other, match };
}

function getRuleTarget(normalizedRule: string): string | undefined {
  const parts = normalizedRule.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  if (parts[0] === 'MATCH') {
    return parts[1];
  }
  return parts[2];
}

function dedupeStringRules(rules: string[]): string[] {
  return dedupeRules(rules) as string[];
}

function dedupeRules<T>(rules: T[]): T[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    if (typeof rule !== 'string') {
      return true;
    }

    const key = rule.trim().toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function findPrimaryProxyTarget(config: Record<string, unknown>): string | null {
  const groups = config['proxy-groups'];
  if (!Array.isArray(groups)) {
    return null;
  }

  for (const group of groups) {
    if (!isRecord(group) || typeof group.name !== 'string') {
      continue;
    }

    const type = typeof group.type === 'string' ? group.type : '';
    const hasProxySource = Array.isArray(group.proxies) || Array.isArray(group.use);
    if (hasProxySource && routableProxyGroupTypes.has(type)) {
      return group.name;
    }
  }

  return null;
}
