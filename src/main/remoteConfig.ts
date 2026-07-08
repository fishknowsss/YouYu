import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteControlConfig, RuleProfile, StrategyKey } from '../shared/ipc';
import { createDeviceAuthHeaders } from './deviceAuth';
import type { TrafficStore } from './traffic/store';

type RemoteConfigClientOptions = {
  baseDir: string;
  endpoint: string;
  appVersion: string;
  store: TrafficStore;
  requestTimeoutMs?: number;
};

type SyncOptions = {
  proxyUrl?: string;
};

type JsonResponse = {
  ok: boolean;
  status: number;
  body: unknown;
};

const remoteConfigFileName = 'remote-config.json';
const validRuleProfiles: RuleProfile[] = ['smart', 'global', 'subscription'];
const validStrategies: StrategyKey[] = ['manual', 'auto', 'fallback', 'load-balance', 'direct'];

export class RemoteConfigClient {
  private readonly filePath: string;
  private loaded = false;
  private cached: RemoteControlConfig | undefined;

  constructor(private readonly options: RemoteConfigClientOptions) {
    this.filePath = join(options.baseDir, remoteConfigFileName);
  }

  async getActiveConfig(): Promise<RemoteControlConfig | undefined> {
    const config = await this.readCached();
    return config?.enabled ? config : undefined;
  }

  async sync(options: SyncOptions = {}): Promise<{ config?: RemoteControlConfig; changed: boolean }> {
    const endpoint = normalizeEndpoint(this.options.endpoint);
    const current = await this.readCached();
    if (!endpoint) {
      return { config: current?.enabled ? current : undefined, changed: false };
    }

    const { identity } = await this.options.store.getSnapshot();
    if (!identity || identity.verificationStatus === 'pending') {
      return { config: current?.enabled ? current : undefined, changed: false };
    }

    const url = new URL(`${endpoint}/api/config`);
    url.searchParams.set('userId', identity.userId);
    url.searchParams.set('deviceId', identity.deviceId);
    url.searchParams.set('appVersion', this.options.appVersion);

    const secret = await this.options.store.getDeviceSecret();
    if (!secret) {
      throw new Error('remote config device secret missing');
    }

    const response = await getJson(
      url.toString(),
      createDeviceAuthHeaders('GET', url.toString(), '', secret),
      options.proxyUrl,
      this.options.requestTimeoutMs
    );
    if (!response.ok) {
      throw new Error(`remote config failed: ${response.status}`);
    }

    const body = isRecord(response.body) && isRecord(response.body.config) ? response.body.config : response.body;
    const next = normalizeRemoteConfig(body);
    if (!next) {
      throw new Error('remote config response invalid');
    }

    await this.writeCached(next);
    return {
      config: next.enabled ? next : undefined,
      changed: JSON.stringify(current ?? null) !== JSON.stringify(next)
    };
  }

  private async readCached(): Promise<RemoteControlConfig | undefined> {
    if (this.loaded) return this.cached;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cached = normalizeRemoteConfig(JSON.parse(raw));
    } catch {
      this.cached = undefined;
    }
    return this.cached;
  }

  private async writeCached(config: RemoteControlConfig): Promise<void> {
    await mkdir(this.options.baseDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    this.loaded = true;
    this.cached = config;
  }
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizeRemoteConfig(value: unknown): RemoteControlConfig | undefined {
  if (!isRecord(value)) return undefined;

  const version = typeof value.version === 'number' && Number.isFinite(value.version)
    ? Math.max(1, Math.floor(value.version))
    : 1;
  const ruleProfile = validRuleProfiles.includes(value.ruleProfile as RuleProfile)
    ? (value.ruleProfile as RuleProfile)
    : undefined;
  const preferredStrategy = validStrategies.includes(value.preferredStrategy as StrategyKey)
    ? (value.preferredStrategy as StrategyKey)
    : undefined;
  const anomalyThresholdBytes =
    typeof value.anomalyThresholdBytes === 'number' &&
    Number.isFinite(value.anomalyThresholdBytes) &&
    value.anomalyThresholdBytes > 0
      ? Math.floor(value.anomalyThresholdBytes)
      : undefined;

  return {
    version,
    enabled: value.enabled !== false,
    subscriptionUrl: normalizeSubscriptionUrl(value.subscriptionUrl),
    ruleProfile,
    preferredNode: normalizeText(value.preferredNode, 120),
    preferredStrategy,
    directRules: normalizeTextList(value.directRules, 120),
    proxyRules: normalizeTextList(value.proxyRules, 120),
    anomalyThresholdBytes,
    updatedAt: normalizeText(value.updatedAt, 40)
  };
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizeSubscriptionUrl(value: unknown): string | undefined {
  const text = normalizeText(value, 2048);
  if (!text) return undefined;

  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? text : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTextList(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item, maxLength))
    .filter((item): item is string => Boolean(item));
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  proxyUrl?: string,
  timeoutMs = 12000
): Promise<JsonResponse> {
  if (proxyUrl) {
    return getJsonViaProxy(url, headers, proxyUrl, timeoutMs);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('remote config request timed out')), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      signal: controller.signal
    });
    return {
      ok: response.ok,
      status: response.status,
      body: parseJson(await response.text())
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getJsonViaProxy(
  url: string,
  headers: Record<string, string>,
  proxyUrl: string,
  timeoutMs: number
): Promise<JsonResponse> {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  if (target.protocol !== 'https:') {
    return getJsonViaHttpProxy(target, proxy, headers, timeoutMs);
  }

  return new Promise((resolve, reject) => {
    const connectReq = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      timeout: timeoutMs
    });

    connectReq.on('connect', (res, socket) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        socket.destroy();
        reject(new Error(`remote config proxy connect failed: ${res.statusCode ?? 0}`));
        return;
      }

      const tlsSocket = tlsConnect({
        socket,
        servername: target.hostname
      });
      const chunks: Buffer[] = [];
      tlsSocket.setTimeout(timeoutMs, () => tlsSocket.destroy(new Error('remote config request timed out')));
      tlsSocket.on('secureConnect', () => {
        tlsSocket.write(
          [
            `GET ${target.pathname}${target.search} HTTP/1.1`,
            `Host: ${target.host}`,
            'Accept: application/json',
            ...formatHeaderLines(headers),
            'Connection: close',
            '',
            ''
          ].join('\r\n')
        );
      });
      tlsSocket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      tlsSocket.on('end', () => resolve(parseHttpResponse(Buffer.concat(chunks).toString('utf8'))));
      tlsSocket.on('error', reject);
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('remote config proxy connect timed out')));
    connectReq.on('error', reject);
    connectReq.end();
  });
}

async function getJsonViaHttpProxy(
  target: URL,
  proxy: URL,
  authHeaders: Record<string, string>,
  timeoutMs: number
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port || 80),
        method: 'GET',
        path: target.toString(),
        timeout: timeoutMs,
        headers: {
          accept: 'application/json',
          ...authHeaders
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            body: parseJson(Buffer.concat(chunks).toString('utf8'))
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('remote config request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function formatHeaderLines(headers: Record<string, string>): string[] {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
}

function parseHttpResponse(raw: string): JsonResponse {
  const [head, ...bodyParts] = raw.split('\r\n\r\n');
  const status = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] ?? 0);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: parseJson(bodyParts.join('\r\n\r\n'))
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
