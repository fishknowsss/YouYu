export type UpdateProxyConfig = {
  mode: 'direct' | 'fixed_servers';
  proxyRules?: string;
  proxyBypassRules?: string;
};

export type UpdateNetworkSession = {
  setProxy: (config: UpdateProxyConfig) => Promise<void>;
  closeAllConnections: () => Promise<void>;
  clearHostResolverCache: () => Promise<void>;
};

type UpdateNetworkOperationOptions<T> = {
  session: UpdateNetworkSession;
  operation: () => Promise<T>;
  proxyUrl?: string;
  getProxyUrl?: () => string | undefined;
  onRetry?: (route: 'direct' | 'local-proxy', detail: string) => void;
};

type UpdateCheckNetworkOptions<T> = Omit<UpdateNetworkOperationOptions<T>, 'operation'> & {
  check: () => Promise<T>;
};

type UpdateDownloadNetworkOptions<T> = Omit<UpdateNetworkOperationOptions<T>, 'operation'> & {
  download: () => Promise<T>;
};

const recoverableUpdateNetworkPattern =
  /(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET)|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_(?:CLOSED|REFUSED|RESET|TIMED_OUT)|ERR_(?:PROXY|TUNNEL)_CONNECTION_FAILED|fetch failed|request timed out|network timeout)/i;
const nonRetryableUpdateSecurityPattern =
  /(?:ERR_CERT_|ERR_SSL_|CERT_(?:HAS_EXPIRED|NOT_YET_VALID)|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)/i;

const githubUpdateBaseUrl = 'https://github.com/fishknowsss/YouYu/releases/latest/download';

export function createHostResolverOptions() {
  return {
    enableBuiltInResolver: true,
    enableHappyEyeballs: true,
    secureDnsMode: 'secure' as const,
    secureDnsServers: [
      'https://doh.pub/dns-query',
      'https://dns.alidns.com/dns-query',
      'https://cloudflare-dns.com/dns-query',
      'https://1.1.1.1/dns-query'
    ]
  };
}

export function createUpdateFeedConfig() {
  return {
    provider: 'generic' as const,
    url: githubUpdateBaseUrl
  };
}

export async function prepareUpdateNetworkSession(
  session: UpdateNetworkSession,
  proxyUrl?: string
): Promise<'direct' | 'local-proxy'> {
  const proxyRules = proxyUrl ? createLocalProxyRules(proxyUrl) : undefined;
  if (proxyRules) {
    await session.setProxy({
      mode: 'fixed_servers',
      proxyRules,
      proxyBypassRules: '<-loopback>'
    });
  } else {
    await session.setProxy({ mode: 'direct' });
  }
  await session.closeAllConnections();
  await session.clearHostResolverCache();
  return proxyRules ? 'local-proxy' : 'direct';
}

export function runUpdateCheckWithNetworkFallback<T>(options: UpdateCheckNetworkOptions<T>): Promise<T> {
  return runUpdateNetworkOperationWithFallback({ ...options, operation: options.check });
}

export function runUpdateDownloadWithNetworkFallback<T>(options: UpdateDownloadNetworkOptions<T>): Promise<T> {
  return runUpdateNetworkOperationWithFallback({ ...options, operation: options.download });
}

async function runUpdateNetworkOperationWithFallback<T>(options: UpdateNetworkOperationOptions<T>): Promise<T> {
  const initialProxyUrl = resolveUpdateProxyUrl(options);
  const initialRoute = await prepareUpdateNetworkSession(options.session, initialProxyUrl);
  try {
    return await options.operation();
  } catch (error) {
    if (!isRecoverableUpdateNetworkError(error)) throw error;
    const retryProxyUrl = initialRoute === 'local-proxy' ? undefined : resolveUpdateProxyUrl(options);
    const route = await prepareUpdateNetworkSession(options.session, retryProxyUrl);
    options.onRetry?.(route, describeNetworkError(error));
  }

  return options.operation();
}

function resolveUpdateProxyUrl(options: Pick<UpdateNetworkOperationOptions<unknown>, 'getProxyUrl' | 'proxyUrl'>) {
  try {
    return options.getProxyUrl?.() ?? options.proxyUrl;
  } catch {
    return options.proxyUrl;
  }
}

export function isRecoverableUpdateNetworkError(error: unknown): boolean {
  const details = flattenErrorDetails(error);
  return !nonRetryableUpdateSecurityPattern.test(details) && recoverableUpdateNetworkPattern.test(details);
}

export function describeNetworkError(error: unknown): string {
  for (const value of getErrorChain(error)) {
    if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string') {
      return sanitizeErrorDetail(value.code);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(recoverableUpdateNetworkPattern);
  return sanitizeErrorDetail(match?.[0] ?? 'network error');
}

function createLocalProxyRules(proxyUrl: string): string | undefined {
  try {
    const proxy = new URL(proxyUrl);
    if (proxy.protocol !== 'http:' || !isLoopbackHost(proxy.hostname) || !proxy.port) return undefined;
    const authority = `${proxy.hostname}:${proxy.port}`;
    return `http=${authority};https=${authority}`;
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function flattenErrorDetails(error: unknown): string {
  return getErrorChain(error)
    .flatMap((value) => {
      if (!value || typeof value !== 'object') return [String(value)];
      const code = 'code' in value && typeof value.code === 'string' ? value.code : '';
      const message = value instanceof Error ? value.message : '';
      return [code, message];
    })
    .join(' ');
}

function getErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current) && chain.length < 5) {
    seen.add(current);
    chain.push(current);
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return chain;
}

function sanitizeErrorDetail(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_:. -]+/g, '').trim();
  return safe.slice(0, 80) || 'network error';
}
