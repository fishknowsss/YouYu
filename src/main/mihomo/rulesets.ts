export type RuleProviderBehavior = 'classical' | 'domain' | 'ipcidr';

export type MihomoRuleProvider = {
  type: 'http' | 'file' | 'inline';
  behavior: RuleProviderBehavior;
  format?: 'yaml' | 'text' | 'mrs';
  path?: string;
  url?: string;
  interval?: number;
  proxy?: string;
};

export type YouYuPolicyGroupOptions = {
  proxyTarget?: string;
  generatedBaseGroupRefs?: string[];
  extraProxyRefs?: string[];
};

export type RuleSetTargetOptions = {
  proxyTarget?: string;
  aiTarget?: string;
  mediaTarget?: string;
  telegramTarget?: string;
  discordTarget?: string;
  devTarget?: string;
  captchaTarget?: string;
  appleTarget?: string;
  microsoftTarget?: string;
  directTarget?: string;
  rejectTarget?: string;
  customDirectRules?: string[];
  customProxyRules?: string[];
  enableAdvertisingBlock?: boolean;
  enablePrivacyBlock?: boolean;
};

const defaultProxy = '节点选择';
const defaultAi = 'AI';
const defaultMedia = '国际媒体';
const defaultTelegram = 'Telegram';
const defaultDiscord = 'Discord';
const defaultDev = '开发平台';
const defaultCaptcha = '验证码';
const defaultApple = '苹果服务';
const defaultMicrosoft = '微软服务';
const defaultDirect = 'DIRECT';
const defaultReject = 'REJECT';

const ruleBase = 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash';

const ruleSets: Array<{ name: string; file: string; behavior: RuleProviderBehavior }> = [
  { name: 'Advertising', file: 'Advertising/Advertising_Classical.yaml', behavior: 'classical' },
  { name: 'Privacy', file: 'Privacy/Privacy_Classical.yaml', behavior: 'classical' },
  { name: 'OpenAI', file: 'OpenAI/OpenAI.yaml', behavior: 'classical' },
  { name: 'Claude', file: 'Claude/Claude.yaml', behavior: 'classical' },
  { name: 'Gemini', file: 'Gemini/Gemini.yaml', behavior: 'classical' },
  { name: 'Telegram', file: 'Telegram/Telegram.yaml', behavior: 'classical' },
  { name: 'Discord', file: 'Discord/Discord.yaml', behavior: 'classical' },
  { name: 'GitHub', file: 'GitHub/GitHub.yaml', behavior: 'classical' },
  { name: 'Google', file: 'Google/Google.yaml', behavior: 'classical' },
  { name: 'YouTube', file: 'YouTube/YouTube.yaml', behavior: 'classical' },
  { name: 'Netflix', file: 'Netflix/Netflix.yaml', behavior: 'classical' },
  { name: 'GlobalMedia', file: 'GlobalMedia/GlobalMedia_Classical.yaml', behavior: 'classical' },
  { name: 'Steam', file: 'Steam/Steam.yaml', behavior: 'classical' },
  { name: 'Apple', file: 'Apple/Apple_Classical.yaml', behavior: 'classical' },
  { name: 'Microsoft', file: 'Microsoft/Microsoft.yaml', behavior: 'classical' },
  { name: 'China', file: 'China/China_Classical_No_Resolve.yaml', behavior: 'classical' },
  { name: 'Proxy', file: 'Proxy/Proxy_Classical_No_Resolve.yaml', behavior: 'classical' }
];

const criticalProxyDomains = [
  'openai.com',
  'chatgpt.com',
  'oaistatic.com',
  'oaiusercontent.com',
  'anthropic.com',
  'claude.ai',
  'gemini.google.com',
  'aistudio.google.com',
  'generativelanguage.googleapis.com',
  'labs.google',
  'flow.google.com',
  'perplexity.ai',
  'poe.com',
  'pixverse.ai',
  'github.com',
  'githubassets.com',
  'githubusercontent.com',
  'githubcopilot.com',
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'discordapp.net',
  'discord.media',
  'hcaptcha.com',
  'hcaptchausercontent.com',
  'js.hcaptcha.com',
  'recaptcha.net',
  'gstatic.com',
  'challenges.cloudflare.com',
  'turnstile.cloudflare.com'
];

export function buildYouYuRuleProviders(downloadProxy = defaultProxy): Record<string, MihomoRuleProvider> {
  return Object.fromEntries(
    ruleSets.map(({ name, file, behavior }) => [
      name,
      {
        type: 'http',
        behavior,
        format: 'yaml',
        interval: 86400,
        proxy: downloadProxy,
        path: `./rulesets/${name}.yaml`,
        url: `${ruleBase}/${file}`
      } satisfies MihomoRuleProvider
    ])
  );
}

export function buildYouYuPolicyGroups(options: string | YouYuPolicyGroupOptions = defaultProxy) {
  const normalizedOptions: YouYuPolicyGroupOptions = typeof options === 'string' ? { proxyTarget: options } : options;
  const proxyTarget = normalizedOptions.proxyTarget ?? defaultProxy;
  const generatedBaseGroupRefs = normalizedOptions.generatedBaseGroupRefs ?? ['自动选择', '故障转移', '负载均衡'];
  const extraProxyRefs = normalizedOptions.extraProxyRefs ?? [];
  const baseProxyRefs = uniq([proxyTarget, ...generatedBaseGroupRefs, ...extraProxyRefs, 'DIRECT']);
  const directFirstRefs = uniq(['DIRECT', proxyTarget, ...generatedBaseGroupRefs, ...extraProxyRefs]);

  return [
    { name: defaultAi, type: 'select', proxies: baseProxyRefs },
    { name: defaultTelegram, type: 'select', proxies: baseProxyRefs },
    { name: defaultDiscord, type: 'select', proxies: baseProxyRefs },
    { name: defaultDev, type: 'select', proxies: baseProxyRefs },
    { name: defaultCaptcha, type: 'select', proxies: baseProxyRefs },
    { name: defaultMedia, type: 'select', proxies: baseProxyRefs },
    { name: defaultApple, type: 'select', proxies: directFirstRefs },
    { name: defaultMicrosoft, type: 'select', proxies: directFirstRefs }
  ];
}

export function buildYouYuRuleSetRules(options: RuleSetTargetOptions = {}): string[] {
  const proxy = options.proxyTarget ?? defaultProxy;
  const ai = options.aiTarget ?? defaultAi;
  const media = options.mediaTarget ?? defaultMedia;
  const telegram = options.telegramTarget ?? defaultTelegram;
  const discord = options.discordTarget ?? defaultDiscord;
  const dev = options.devTarget ?? defaultDev;
  const captcha = options.captchaTarget ?? defaultCaptcha;
  const apple = options.appleTarget ?? defaultApple;
  const microsoft = options.microsoftTarget ?? defaultMicrosoft;
  const direct = options.directTarget ?? defaultDirect;
  const reject = options.rejectTarget ?? defaultReject;
  const enableAdvertisingBlock = options.enableAdvertisingBlock ?? false;
  const enablePrivacyBlock = options.enablePrivacyBlock ?? false;

  return dedupeRules([
    ...normalizeCustomRules(options.customDirectRules, direct),
    ...normalizeCustomRules(options.customProxyRules, proxy),
    ...buildYouYuCriticalProxyRules(proxy),
    ...(enableAdvertisingBlock ? [`RULE-SET,Advertising,${reject}`] : []),
    ...(enablePrivacyBlock ? [`RULE-SET,Privacy,${reject}`] : []),
    `RULE-SET,OpenAI,${ai}`,
    `RULE-SET,Claude,${ai}`,
    `RULE-SET,Gemini,${ai}`,
    `RULE-SET,Telegram,${telegram}`,
    `RULE-SET,Discord,${discord}`,
    `RULE-SET,GitHub,${dev}`,
    `RULE-SET,YouTube,${media}`,
    `RULE-SET,Netflix,${media}`,
    `RULE-SET,GlobalMedia,${media}`,
    `RULE-SET,Steam,${proxy}`,
    `RULE-SET,Google,${proxy}`,
    `RULE-SET,Apple,${apple}`,
    `RULE-SET,Microsoft,${microsoft}`,
    `RULE-SET,China,${direct}`,
    `GEOIP,CN,${direct},no-resolve`,
    `RULE-SET,Proxy,${proxy}`,
    `MATCH,${proxy}`
  ]);
}

export function buildYouYuCriticalProxyRules(proxyTarget = defaultProxy): string[] {
  return criticalProxyDomains.map((domain) => `DOMAIN-SUFFIX,${domain},${proxyTarget}`);
}

export function isYouYuCriticalProxyDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase();
  return criticalProxyDomains.includes(normalized);
}

export function mergeProxyGroupsByName(existingGroups: unknown, groupsToAdd: unknown[]) {
  if (!Array.isArray(existingGroups)) return groupsToAdd;
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const group of [...existingGroups, ...groupsToAdd]) {
    if (!isRecord(group) || typeof group.name !== 'string') {
      result.push(group);
      continue;
    }
    const key = group.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(group);
  }
  return result;
}

export function pickExistingGroupRefs(existingGroups: unknown, candidates = ['自动选择', '故障转移', '负载均衡']): string[] {
  if (!Array.isArray(existingGroups)) return [];
  const names = new Set(
    existingGroups
      .map((group) => (isRecord(group) && typeof group.name === 'string' ? group.name : undefined))
      .filter((name): name is string => Boolean(name))
  );
  return candidates.filter((candidate) => names.has(candidate));
}

function normalizeCustomRules(rules: string[] | undefined, fallbackTarget: string): string[] {
  if (!rules?.length) return [];
  return rules
    .map((rule) => normalizeCustomRule(rule, fallbackTarget))
    .filter((rule): rule is string => Boolean(rule));
}

function normalizeCustomRule(rule: string, fallbackTarget: string): string | undefined {
  const parts = rule
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  const type = parts[0].toUpperCase();
  const supportedTypes = new Set([
    'DOMAIN',
    'DOMAIN-SUFFIX',
    'DOMAIN-KEYWORD',
    'DOMAIN-WILDCARD',
    'IP-CIDR',
    'IP-CIDR6',
    'PROCESS-NAME',
    'PROCESS-PATH'
  ]);
  if (!supportedTypes.has(type)) return undefined;
  if (parts.length === 2) return `${type},${parts[1]},${fallbackTarget}`;
  const target = parts[2].toUpperCase() === 'PROXY' ? fallbackTarget : parts[2];
  return [type, parts[1], target, ...parts.slice(3)].join(',');
}

function dedupeRules(rules: string[]): string[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = rule.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
