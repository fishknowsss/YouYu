import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ConnectivityCategory,
  ConnectivityReachability,
  ConnectivityResult,
  ConnectivityServiceKey,
  ConnectivityStatus,
  ConnectivityTimings
} from '../shared/ipc';
import { EXTERNAL_RESPONSE_BODY_LIMITS, readFetchTextBounded } from './http/boundedBody';

const execFileAsync = promisify(execFile);

type ConnectivityService = {
  key: ConnectivityServiceKey;
  name: string;
  url: string;
  probeUrl: string;
  host: string;
  category: ConnectivityCategory;
  kind: 'trace' | 'http' | 'flow';
};

const steamConnectivityKeys = new Set<ConnectivityServiceKey>(['steam', 'steamNetwork', 'steamCloud']);

export type CurlProbe = {
  httpCode?: number;
  finalUrl?: string;
  remoteIp?: string;
  timings: ConnectivityTimings;
  body?: string;
};

type TraceData = {
  ip?: string;
  loc?: string;
  colo?: string;
};

type MihomoConnection = {
  metadata?: {
    host?: string;
    destinationIP?: string;
  };
  rule?: string;
  rulePayload?: string;
  chains?: string[];
};

type MihomoConnectionsResponse = {
  connections?: MihomoConnection[];
};

export const connectivityServices: ConnectivityService[] = [
  {
    key: 'steam',
    name: 'Steam',
    url: 'https://store.steampowered.com',
    probeUrl: 'https://store.steampowered.com/robots.txt',
    host: 'store.steampowered.com',
    category: 'special',
    kind: 'http'
  },
  {
    key: 'steamNetwork',
    name: 'Steam 联机',
    url: 'https://api.steampowered.com',
    probeUrl: 'https://api.steampowered.com/ISteamDirectory/GetCMList/v1/?cellid=0&format=json',
    host: 'api.steampowered.com',
    category: 'special',
    kind: 'http'
  },
  {
    key: 'steamCloud',
    name: 'Steam 云同步',
    url: 'https://steamcloud-ugc.storage.googleapis.com',
    probeUrl: 'https://steamcloud-ugc.storage.googleapis.com',
    host: 'steamcloud-ugc.storage.googleapis.com',
    category: 'special',
    kind: 'http'
  },
  {
    key: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    probeUrl: 'https://chatgpt.com/cdn-cgi/trace',
    host: 'chatgpt.com',
    category: 'ai',
    kind: 'trace'
  },
  {
    key: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    probeUrl: 'https://claude.ai/cdn-cgi/trace',
    host: 'claude.ai',
    category: 'ai',
    kind: 'trace'
  },
  {
    key: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    probeUrl: 'https://gemini.google.com',
    host: 'gemini.google.com',
    category: 'ai',
    kind: 'http'
  },
  {
    key: 'flow',
    name: 'Flow',
    url: 'https://labs.google/fx/tools/flow',
    probeUrl: 'https://labs.google/fx/tools/flow',
    host: 'labs.google',
    category: 'special',
    kind: 'flow'
  },
  {
    key: 'pixverse',
    name: 'PixVerse',
    url: 'https://app.pixverse.ai',
    probeUrl: 'https://app.pixverse.ai',
    host: 'app.pixverse.ai',
    category: 'ai',
    kind: 'http'
  },
  {
    key: 'microsoftStore',
    name: 'Microsoft 商店',
    url: 'https://apps.microsoft.com',
    probeUrl: 'https://apps.microsoft.com',
    host: 'apps.microsoft.com',
    category: 'special',
    kind: 'http'
  },
  {
    key: 'discord',
    name: 'Discord',
    url: 'https://discord.com',
    probeUrl: 'https://discord.com/api/v10/gateway',
    host: 'discord.com',
    category: 'special',
    kind: 'http'
  },
  {
    key: 'turnstile',
    name: 'Cloudflare 验证',
    url: 'https://challenges.cloudflare.com',
    probeUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    host: 'challenges.cloudflare.com',
    category: 'special',
    kind: 'http'
  },
  {
    key: 'recaptcha',
    name: 'Google 验证',
    url: 'https://www.recaptcha.net',
    probeUrl: 'https://www.recaptcha.net/recaptcha/api.js',
    host: 'www.recaptcha.net',
    category: 'special',
    kind: 'http'
  },
  {
    key: 'hcaptcha',
    name: 'hCaptcha',
    url: 'https://js.hcaptcha.com',
    probeUrl: 'https://js.hcaptcha.com/1/api.js',
    host: 'js.hcaptcha.com',
    category: 'special',
    kind: 'http'
  },
  {
    key: 'google',
    name: 'Google',
    url: 'https://www.google.com',
    probeUrl: 'https://www.google.com/generate_204',
    host: 'www.google.com',
    category: 'global',
    kind: 'http'
  },
  {
    key: 'cloudflare',
    name: 'Cloudflare',
    url: 'https://www.cloudflare.com',
    probeUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
    host: 'www.cloudflare.com',
    category: 'global',
    kind: 'trace'
  }
];

export type ConnectivityDeps = {
  getMixedPort: () => number;
  getControllerPort: () => number;
  getControllerSecret: () => Promise<string>;
  isRunning: () => boolean;
};

export type ConnectivityProbeRunner = (
  url: string,
  mixedPort: number,
  options: { captureBody: boolean; signal?: AbortSignal }
) => Promise<CurlProbe>;

export type ConnectivityTestOptions = {
  signal?: AbortSignal;
  runProbe?: ConnectivityProbeRunner;
};

export async function testConnectivity(
  deps: ConnectivityDeps,
  key: ConnectivityServiceKey,
  options: ConnectivityTestOptions = {}
): Promise<ConnectivityResult> {
  throwIfConnectivityTestAborted(options.signal);
  const service = findService(key);
  if (!deps.isRunning()) {
    return createResult(service, 'failed', '未启动', {}, '先启动代理');
  }

  const checkedAt = new Date().toISOString();
  try {
    const probe = await runServiceProbe(service, deps.getMixedPort(), options);
    const route = await findRecentConnection(deps, service.host, options.signal).catch(() => {
      throwIfConnectivityTestAborted(options.signal);
      return undefined;
    });
    const status = getServiceStatus(service.key, probe);
    const reachability = getReachability(service.key, probe);
    const trace = service.kind === 'trace' ? parseTraceData(probe.body) : {};
    const region = trace.ip
      ? await lookupIpCountry(trace.ip, options.signal).catch(() => {
          throwIfConnectivityTestAborted(options.signal);
          return formatTraceRegion(trace);
        })
      : undefined;
    throwIfConnectivityTestAborted(options.signal);

    return {
      key: service.key,
      name: service.name,
      url: service.url,
      category: service.category,
      status,
      statusText: getStatusText(status, reachability, service.key, probe),
      reachability,
      checkedAt,
      httpCode: probe.httpCode,
      finalUrl: probe.finalUrl,
      ip: trace.ip,
      region,
      colo: trace.colo,
      timings: probe.timings,
      rule: route?.rule,
      rulePayload: route?.rulePayload,
      chains: route?.chains
    };
  } catch (error) {
    throwIfConnectivityTestAborted(options.signal);
    const message = formatProbeError(error);
    const timeout = /超时|timed out|timeout|operation timeout/i.test(message);
    return createResult(service, timeout ? 'timeout' : 'failed', timeout ? '超时' : '失败', {}, message, checkedAt);
  }
}

async function runServiceProbe(
  service: ConnectivityService,
  mixedPort: number,
  options: ConnectivityTestOptions
): Promise<CurlProbe> {
  const runProbe = options.runProbe ?? runCurlProbe;
  const attempts = steamConnectivityKeys.has(service.key) ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfConnectivityTestAborted(options.signal);
    try {
      return await runProbe(service.probeUrl, mixedPort, {
        captureBody: service.kind === 'trace',
        signal: options.signal
      });
    } catch (error) {
      throwIfConnectivityTestAborted(options.signal);
      if (attempt + 1 >= attempts || !isTransientProbeFailure(error)) throw error;
    }
  }

  throw new Error('connectivity probe did not run');
}

function formatProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/could not resolve|resolve host|name or service not known/i.test(message)) return 'DNS 解析失败';
  if (/certificate|cert verify|cert_authority_invalid/i.test(message)) return 'TLS 证书校验失败';
  if (/ssl|tls|schannel|handshake/i.test(message)) {
    return /timed out|timeout/i.test(message) ? 'TLS 握手超时' : 'TLS 握手失败';
  }
  if (/failed to connect|connection timed out|connect.*timed out/i.test(message)) return 'TCP 连接超时';
  return message;
}

function isTransientProbeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|could not resolve|temporary failure|failed to connect|connection refused|connection reset|recv failure|receive failure|empty reply|ssl connect error|tls connect|handshake failure/i.test(
    message
  );
}

export async function testAllConnectivity(
  deps: ConnectivityDeps,
  options: ConnectivityTestOptions = {}
): Promise<ConnectivityResult[]> {
  throwIfConnectivityTestAborted(options.signal);
  const results: ConnectivityResult[] = [];
  const queue = [...connectivityServices];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      throwIfConnectivityTestAborted(options.signal);
      const service = queue.shift();
      if (service) {
        results.push(await testConnectivity(deps, service.key, options));
      }
    }
  });
  await Promise.all(workers);
  throwIfConnectivityTestAborted(options.signal);
  return sortResults(results);
}

export function parseCurlMetrics(text: string): CurlProbe {
  const marker = '\n__YOUYU_CURL_METRICS__\n';
  const markerIndex = text.lastIndexOf(marker);
  const body = markerIndex >= 0 ? text.slice(0, markerIndex) : '';
  const metricsText = markerIndex >= 0 ? text.slice(markerIndex + marker.length) : text;
  const values = new Map<string, string>();

  for (const line of metricsText.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) {
      values.set(line.slice(0, index), line.slice(index + 1));
    }
  }

  const httpCode = parseInteger(values.get('http_code'));
  return {
    httpCode: httpCode && httpCode > 0 ? httpCode : undefined,
    finalUrl: values.get('url_effective') || undefined,
    remoteIp: values.get('remote_ip') || undefined,
    body,
    timings: {
      connectMs: secondsToMs(values.get('time_connect')),
      tlsMs: secondsToMs(values.get('time_appconnect')),
      firstByteMs: secondsToMs(values.get('time_starttransfer')),
      totalMs: secondsToMs(values.get('time_total'))
    }
  };
}

function findService(key: ConnectivityServiceKey): ConnectivityService {
  const service = connectivityServices.find((item) => item.key === key);
  if (!service) {
    throw new Error(`unknown connectivity service: ${key}`);
  }
  return service;
}

async function runCurlProbe(
  url: string,
  mixedPort: number,
  options: { captureBody: boolean; signal?: AbortSignal }
): Promise<CurlProbe> {
  const outputTarget = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const args = [
    '--proxy',
    `http://127.0.0.1:${mixedPort}`,
    '--location',
    '--silent',
    '--show-error',
    '--max-time',
    '20',
    '--connect-timeout',
    '8',
    '--user-agent',
    'Mozilla/5.0 YouYu Connectivity Check',
    ...(options.captureBody ? [] : ['--output', outputTarget]),
    '--write-out',
    '\n__YOUYU_CURL_METRICS__\nhttp_code=%{http_code}\nurl_effective=%{url_effective}\nremote_ip=%{remote_ip}\ntime_connect=%{time_connect}\ntime_appconnect=%{time_appconnect}\ntime_starttransfer=%{time_starttransfer}\ntime_total=%{time_total}\n',
    url
  ];
  const curlCommand = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const { stdout } = await execFileAsync(curlCommand, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    signal: options.signal
  });
  return parseCurlMetrics(stdout);
}

function throwIfConnectivityTestAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('operation canceled');
}

export function parseTraceData(body?: string): TraceData {
  const data: TraceData = {};
  if (!body) return data;

  for (const line of body.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === 'ip') data.ip = value;
    if (key === 'loc') data.loc = value;
    if (key === 'colo') data.colo = value;
  }
  return data;
}

async function lookupIpCountry(ip: string, signal?: AbortSignal): Promise<string | undefined> {
  const response = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,query`, {
    signal
  });
  const body = await readFetchTextBounded(response, {
    maxBytes: EXTERNAL_RESPONSE_BODY_LIMITS.ipLookupJson,
    scope: 'IP lookup',
    signal
  });
  if (!response.ok) return undefined;
  const data = JSON.parse(body) as {
    status?: string;
    country?: string;
  };
  if (data.status !== 'success') return undefined;
  return data.country;
}

function formatTraceRegion(trace: TraceData): string | undefined {
  return trace.loc;
}

async function findRecentConnection(
  deps: ConnectivityDeps,
  host: string,
  signal?: AbortSignal
): Promise<MihomoConnection | undefined> {
  const secret = await deps.getControllerSecret();
  const response = await fetch(`http://127.0.0.1:${deps.getControllerPort()}/connections`, {
    headers: {
      Authorization: `Bearer ${secret}`
    },
    signal
  });
  if (!response.ok) return undefined;

  const data = (await response.json()) as MihomoConnectionsResponse;
  return data.connections?.find((connection) => {
    const currentHost = connection.metadata?.host ?? '';
    return (
      Boolean(currentHost) && (currentHost === host || currentHost.endsWith(`.${host}`) || host.endsWith(currentHost))
    );
  });
}

function getServiceStatus(key: ConnectivityServiceKey, probe: CurlProbe): ConnectivityStatus {
  const code = probe.httpCode ?? 0;
  const finalUrl = probe.finalUrl ?? '';
  if (key === 'flow' && finalUrl.includes('/unsupported-country')) {
    return 'blocked';
  }
  if (code === 0) return 'failed';
  if (key === 'steamCloud' && code === 404) return 'available';
  if ((code >= 200 && code < 400) || code === 401 || code === 403) return 'available';
  if (code === 451) return 'blocked';
  return code >= 500 ? 'failed' : 'blocked';
}

function getReachability(key: ConnectivityServiceKey, probe: CurlProbe): ConnectivityReachability {
  const code = probe.httpCode ?? 0;
  if (key === 'flow' && probe.finalUrl?.includes('/unsupported-country')) return 'blocked';
  if (key === 'steamCloud' && code === 404) return 'ok';
  if (code === 403) return 'guarded';
  if ((code >= 200 && code < 400) || code === 401) return 'ok';
  if (code === 451) return 'blocked';
  return 'unknown';
}

function getStatusText(
  status: ConnectivityStatus,
  reachability: ConnectivityReachability,
  key: ConnectivityServiceKey,
  probe: CurlProbe
): string {
  if (status === 'available') return reachability === 'guarded' ? '可达' : '可用';
  if (status === 'timeout') return '超时';
  if (key === 'flow' && probe.finalUrl?.includes('/unsupported-country')) return '地区受限';
  if (status === 'blocked') return '受限';
  if (status === 'failed') return '失败';
  return '未测';
}

function createResult(
  service: ConnectivityService,
  status: ConnectivityStatus,
  statusText: string,
  timings: ConnectivityTimings,
  error?: string,
  checkedAt?: string
): ConnectivityResult {
  return {
    key: service.key,
    name: service.name,
    url: service.url,
    category: service.category,
    status,
    statusText,
    reachability: status === 'available' ? 'ok' : 'unknown',
    checkedAt,
    timings,
    error
  };
}

function sortResults(results: ConnectivityResult[]): ConnectivityResult[] {
  const order = new Map(connectivityServices.map((service, index) => [service.key, index]));
  return results.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

function secondsToMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 1000);
}

function parseInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
