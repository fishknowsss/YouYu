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

type CurlProbe = {
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
    key: 'runway',
    name: 'Runway',
    url: 'https://app.runwayml.com',
    probeUrl: 'https://app.runwayml.com',
    host: 'app.runwayml.com',
    category: 'ai',
    kind: 'http'
  },
  {
    key: 'bytedance',
    name: '字节跳动',
    url: 'https://www.bytedance.com',
    probeUrl: 'https://www.bytedance.com',
    host: 'www.bytedance.com',
    category: 'global',
    kind: 'http'
  },
  {
    key: 'tencent',
    name: '腾讯',
    url: 'https://www.tencent.com',
    probeUrl: 'https://www.tencent.com',
    host: 'www.tencent.com',
    category: 'domestic',
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
    key: 'x',
    name: 'X',
    url: 'https://x.com',
    probeUrl: 'https://x.com/cdn-cgi/trace',
    host: 'x.com',
    category: 'global',
    kind: 'trace'
  },
  {
    key: 'cloudflare',
    name: 'Cloudflare',
    url: 'https://www.cloudflare.com',
    probeUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
    host: 'www.cloudflare.com',
    category: 'global',
    kind: 'trace'
  },
  {
    key: 'ehentai',
    name: 'E-Hentai',
    url: 'https://e-hentai.org',
    probeUrl: 'https://e-hentai.org/cdn-cgi/trace',
    host: 'e-hentai.org',
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

export async function testConnectivity(
  deps: ConnectivityDeps,
  key: ConnectivityServiceKey
): Promise<ConnectivityResult> {
  const service = findService(key);
  if (!deps.isRunning()) {
    return createResult(service, 'failed', '未启动', {}, '先启动代理');
  }

  const checkedAt = new Date().toISOString();
  try {
    const probe = await runCurlProbe(service.probeUrl, deps.getMixedPort(), service.kind === 'trace');
    const route = await findRecentConnection(deps, service.host).catch(() => undefined);
    const status = getServiceStatus(service.key, probe);
    const reachability = getReachability(service.key, probe);
    const trace = service.kind === 'trace' ? parseTraceData(probe.body) : {};
    const region = trace.ip ? await lookupIpCountry(trace.ip).catch(() => formatTraceRegion(trace)) : undefined;

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
    const message = error instanceof Error ? error.message : String(error);
    const timeout = /timed out|timeout|operation timeout/i.test(message);
    return createResult(service, timeout ? 'timeout' : 'failed', timeout ? '超时' : '失败', {}, message, checkedAt);
  }
}

export async function testAllConnectivity(deps: ConnectivityDeps): Promise<ConnectivityResult[]> {
  const results: ConnectivityResult[] = [];
  const queue = [...connectivityServices];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const service = queue.shift();
      if (service) {
        results.push(await testConnectivity(deps, service.key));
      }
    }
  });
  await Promise.all(workers);
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

async function runCurlProbe(url: string, mixedPort: number, captureBody = false): Promise<CurlProbe> {
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
    ...(captureBody ? [] : ['--output', outputTarget]),
    '--write-out',
    '\n__YOUYU_CURL_METRICS__\nhttp_code=%{http_code}\nurl_effective=%{url_effective}\nremote_ip=%{remote_ip}\ntime_connect=%{time_connect}\ntime_appconnect=%{time_appconnect}\ntime_starttransfer=%{time_starttransfer}\ntime_total=%{time_total}\n',
    url
  ];
  const curlCommand = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const { stdout } = await execFileAsync(curlCommand, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return parseCurlMetrics(stdout);
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

async function lookupIpCountry(ip: string): Promise<string | undefined> {
  const response = await fetch(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,query`
  );
  if (!response.ok) return undefined;
  const data = (await response.json()) as {
    status?: string;
    country?: string;
  };
  if (data.status !== 'success') return undefined;
  return data.country;
}

function formatTraceRegion(trace: TraceData): string | undefined {
  return trace.loc;
}

async function findRecentConnection(deps: ConnectivityDeps, host: string): Promise<MihomoConnection | undefined> {
  const secret = await deps.getControllerSecret();
  const response = await fetch(`http://127.0.0.1:${deps.getControllerPort()}/connections`, {
    headers: {
      Authorization: `Bearer ${secret}`
    }
  });
  if (!response.ok) return undefined;

  const data = (await response.json()) as MihomoConnectionsResponse;
  return data.connections?.find((connection) => {
    const currentHost = connection.metadata?.host ?? '';
    return Boolean(currentHost) && (currentHost === host || currentHost.endsWith(`.${host}`) || host.endsWith(currentHost));
  });
}

function getServiceStatus(key: ConnectivityServiceKey, probe: CurlProbe): ConnectivityStatus {
  const code = probe.httpCode ?? 0;
  const finalUrl = probe.finalUrl ?? '';
  if (key === 'flow' && finalUrl.includes('/unsupported-country')) {
    return 'blocked';
  }
  if (code === 0) return 'failed';
  if ((code >= 200 && code < 400) || code === 401 || code === 403) return 'available';
  if (code === 451) return 'blocked';
  return code >= 500 ? 'failed' : 'blocked';
}

function getReachability(key: ConnectivityServiceKey, probe: CurlProbe): ConnectivityReachability {
  const code = probe.httpCode ?? 0;
  if (key === 'flow' && probe.finalUrl?.includes('/unsupported-country')) return 'blocked';
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
