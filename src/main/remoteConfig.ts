import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { join } from 'node:path';
import type { RemoteControlConfig, RuleProfile, StrategyKey } from '../shared/ipc';
import { createDeviceAuthHeaders } from './deviceAuth';
import {
  EXTERNAL_RESPONSE_BODY_LIMITS,
  readFetchTextBounded,
  readIncomingMessageTextBounded
} from './http/boundedBody';
import { runNetworkFallback, type FetchLike, type NetworkRoute } from './networkFallback';
import type { TrafficStore } from './traffic/store';
import { readJsonFile, writeJsonFileAtomic } from './storage/jsonFile';

type RemoteConfigClientOptions = {
  baseDir: string;
  endpoint: string;
  appVersion: string;
  store: TrafficStore;
  requestTimeoutMs?: number;
  fetch?: FetchLike;
};

type SyncOptions = {
  proxyUrl?: string;
  signal?: AbortSignal;
};

type JsonResponse = {
  ok: boolean;
  status: number;
  body: unknown;
  route: NetworkRoute;
  directOutcome?: string;
};

type RawJsonResponse = Omit<JsonResponse, 'route' | 'directOutcome'>;
type RemoteConfigPayload = Omit<RemoteControlConfig, 'ruleProfile'> & {
  ruleProfile?: RuleProfile | 'smart' | 'global';
};

type RemoteConfigIdentity = {
  userId: string;
  deviceId: string;
};

type RemoteConfigCache = {
  schemaVersion: 1;
  identity: RemoteConfigIdentity;
  config: RemoteControlConfig;
};

export type ActiveRemoteConfigSnapshot = {
  binding?: string;
  revision: string;
  config?: RemoteControlConfig;
};

const remoteConfigFileName = 'remote-config.json';
const validRuleProfiles: RuleProfile[] = ['ruleset', 'subscription'];
const legacyRuleProfiles = new Set(['smart', 'global']);
const validStrategies: StrategyKey[] = ['manual', 'auto', 'fallback', 'load-balance', 'direct'];

export class RemoteConfigClient {
  private readonly filePath: string;
  private loaded = false;
  private cached: RemoteConfigCache | undefined;
  private loadPromise?: Promise<RemoteConfigCache | undefined>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RemoteConfigClientOptions) {
    this.filePath = join(options.baseDir, remoteConfigFileName);
  }

  async getActiveConfig(): Promise<RemoteControlConfig | undefined> {
    return (await this.getActiveConfigSnapshot()).config;
  }

  async getActiveConfigSnapshot(): Promise<ActiveRemoteConfigSnapshot> {
    const cached = await this.readCached();
    const identity = await this.getCurrentIdentity();
    const config = configForIdentity(cached, identity);
    return {
      binding: identityBinding(identity),
      revision: JSON.stringify(config ?? null),
      config: config?.enabled ? config : undefined
    };
  }

  async isActiveConfigSnapshotCurrent(snapshot: ActiveRemoteConfigSnapshot): Promise<boolean> {
    const current = await this.getActiveConfigSnapshot();
    return current.binding === snapshot.binding && current.revision === snapshot.revision;
  }

  async sync(options: SyncOptions = {}): Promise<{ config?: RemoteControlConfig; changed: boolean }> {
    const run = this.queue.then(
      () => this.performSync(options),
      () => this.performSync(options)
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async performSync(options: SyncOptions): Promise<{ config?: RemoteControlConfig; changed: boolean }> {
    const endpoint = normalizeEndpoint(this.options.endpoint);
    const cached = await this.readCached();
    const identity = await this.getCurrentIdentity();
    const current = configForIdentity(cached, identity);
    if (!identity) {
      return { config: undefined, changed: false };
    }
    if (!endpoint) {
      return { config: current?.enabled ? current : undefined, changed: false };
    }

    const requestedUserId = identity.userId;
    const requestedDeviceId = identity.deviceId;

    const url = new URL(`${endpoint}/api/config`);
    url.searchParams.set('userId', requestedUserId);
    url.searchParams.set('deviceId', requestedDeviceId);
    url.searchParams.set('appVersion', this.options.appVersion);

    const secret = await this.options.store.getDeviceSecret();
    if (!secret) {
      throw new Error('remote config device secret missing');
    }

    const response = await getJson(
      url.toString(),
      createDeviceAuthHeaders('GET', url.toString(), '', secret),
      options.proxyUrl,
      this.options.requestTimeoutMs,
      options.signal,
      this.options.fetch
    );
    if (!response.ok) {
      throw new Error(`remote config failed: ${response.status} (${responseRouteDetails(response)})`);
    }

    const body = isRecord(response.body) && isRecord(response.body.config) ? response.body.config : response.body;
    const next = normalizeRemoteConfig(body);
    if (!next) {
      throw new Error(`remote config response invalid (${responseRouteDetails(response)})`);
    }
    const latestIdentity = await this.getCurrentIdentity();
    if (!sameIdentity(latestIdentity, identity)) {
      const latestConfig = configForIdentity(cached, latestIdentity);
      return { config: latestConfig?.enabled ? latestConfig : undefined, changed: false };
    }

    await this.writeCached(next, identity);
    const committedIdentity = await this.getCurrentIdentity();
    if (!sameIdentity(committedIdentity, identity)) {
      const committedConfig = configForIdentity(this.cached, committedIdentity);
      return { config: committedConfig?.enabled ? committedConfig : undefined, changed: false };
    }
    return {
      config: next.enabled ? next : undefined,
      changed: JSON.stringify(current ?? null) !== JSON.stringify(next)
    };
  }

  private async getCurrentIdentity(): Promise<RemoteConfigIdentity | undefined> {
    const { identity } = await this.options.store.getSnapshot();
    if (!identity || identity.verificationStatus === 'pending') return undefined;
    return { userId: identity.userId, deviceId: identity.deviceId };
  }

  private async readCached(): Promise<RemoteConfigCache | undefined> {
    if (this.loaded) return this.cached;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const result = await readJsonFile<unknown>(this.filePath, {
          preserveInvalid: false,
          validate: (value) => normalizeRemoteConfigCache(value) !== undefined
        });
        this.cached = result.status === 'found' ? normalizeRemoteConfigCache(result.value) : undefined;
        this.loaded = true;
        return this.cached;
      })().finally(() => {
        this.loadPromise = undefined;
      });
    }
    return this.loadPromise;
  }

  private async writeCached(config: RemoteControlConfig, identity: RemoteConfigIdentity): Promise<void> {
    const cached: RemoteConfigCache = {
      schemaVersion: 1,
      identity,
      config
    };
    await writeJsonFileAtomic(this.filePath, cached);
    this.loaded = true;
    this.cached = cached;
  }
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizeRemoteConfigCache(value: unknown): RemoteConfigCache | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.identity)) return undefined;
  const userId = normalizeText(value.identity.userId, 160);
  const deviceId = normalizeText(value.identity.deviceId, 160);
  const config = normalizeRemoteConfig(value.config);
  if (!userId || !deviceId || !config) return undefined;
  return {
    schemaVersion: 1,
    identity: { userId, deviceId },
    config
  };
}

function configForIdentity(
  cached: RemoteConfigCache | undefined,
  identity: RemoteConfigIdentity | undefined
): RemoteControlConfig | undefined {
  return cached && sameIdentity(cached.identity, identity) ? cached.config : undefined;
}

function sameIdentity(left: RemoteConfigIdentity | undefined, right: RemoteConfigIdentity | undefined): boolean {
  return Boolean(left && right && left.userId === right.userId && left.deviceId === right.deviceId);
}

function identityBinding(identity: RemoteConfigIdentity | undefined): string | undefined {
  return identity ? JSON.stringify([identity.userId, identity.deviceId]) : undefined;
}

function normalizeRemoteConfig(value: unknown): RemoteControlConfig | undefined {
  if (!isRemoteConfigPayload(value)) return undefined;

  const version = Math.floor(value.version);
  const ruleProfile = normalizeRuleProfile(value.ruleProfile);
  const subscriptionUrl = normalizeSubscriptionUrl(value.subscriptionUrl);
  const updatedAt = normalizeText(value.updatedAt, 40);

  return {
    version,
    enabled: value.enabled,
    ...(subscriptionUrl ? { subscriptionUrl } : {}),
    ...(ruleProfile ? { ruleProfile } : {}),
    directRules: [],
    proxyRules: [],
    ...(updatedAt ? { updatedAt } : {})
  };
}

function isRemoteConfigPayload(value: unknown): value is RemoteConfigPayload {
  if (!isRecord(value)) return false;
  if (typeof value.version !== 'number' || !Number.isFinite(value.version) || value.version < 1) return false;
  if (typeof value.enabled !== 'boolean') return false;
  if (!isTextList(value.directRules) || !isTextList(value.proxyRules)) return false;
  if (typeof value.subscriptionUrl !== 'undefined' && !normalizeSubscriptionUrl(value.subscriptionUrl)) return false;
  if (
    typeof value.ruleProfile !== 'undefined' &&
    !validRuleProfiles.includes(value.ruleProfile as RuleProfile) &&
    !legacyRuleProfiles.has(value.ruleProfile as string)
  ) {
    return false;
  }
  if (typeof value.preferredNode !== 'undefined' && typeof value.preferredNode !== 'string') return false;
  if (
    typeof value.preferredStrategy !== 'undefined' &&
    !validStrategies.includes(value.preferredStrategy as StrategyKey)
  ) {
    return false;
  }
  if (
    typeof value.anomalyThresholdBytes !== 'undefined' &&
    (typeof value.anomalyThresholdBytes !== 'number' ||
      !Number.isFinite(value.anomalyThresholdBytes) ||
      value.anomalyThresholdBytes <= 0)
  ) {
    return false;
  }
  if (typeof value.updatedAt !== 'undefined' && typeof value.updatedAt !== 'string') return false;
  return true;
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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

function normalizeRuleProfile(value: unknown): RuleProfile | undefined {
  if (legacyRuleProfiles.has(value as string)) return 'ruleset';
  return validRuleProfiles.includes(value as RuleProfile) ? (value as RuleProfile) : undefined;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  proxyUrl?: string,
  timeoutMs = 12000,
  operationSignal?: AbortSignal,
  fetch?: FetchLike
): Promise<JsonResponse> {
  const result = await runNetworkFallback<RawJsonResponse>({
    scope: 'remote config request',
    proxyUrl,
    timeoutMs,
    signal: operationSignal,
    fetch,
    getStatus: (response) => response.status,
    direct: async ({ fetch: directFetch, signal }) => {
      const response = await directFetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal
      });
      return {
        ok: response.ok,
        status: response.status,
        body: parseJson(
          await readFetchTextBounded(response, {
            maxBytes: EXTERNAL_RESPONSE_BODY_LIMITS.remoteConfigJson,
            scope: 'remote config',
            signal
          })
        )
      };
    },
    proxy: ({ proxyUrl: fallbackProxyUrl, timeoutMs: remainingMs, signal }) =>
      getJsonViaProxy(url, headers, fallbackProxyUrl, remainingMs, signal)
  });
  return { ...result.response, route: result.route, directOutcome: result.directOutcome };
}

function responseRouteDetails(response: JsonResponse): string {
  const current = `route=${response.route} status=${response.status}`;
  return response.directOutcome ? `${current} direct=${response.directOutcome} proxy=HTTP_${response.status}` : current;
}

async function getJsonViaProxy(
  url: string,
  headers: Record<string, string>,
  proxyUrl: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RawJsonResponse> {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  if (target.protocol !== 'https:') {
    return getJsonViaHttpProxy(target, proxy, headers, timeoutMs, signal);
  }

  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let settled = false;
    let tunneledRequest: ReturnType<typeof httpsRequest> | undefined;
    let responseStarted = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const resolveOnce = (response: RawJsonResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const connectReq = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      timeout: timeoutMs
    });
    const abort = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new Error('operation canceled');
      connectReq.destroy(error);
      tunneledRequest?.destroy(error);
      rejectOnce(error);
    };
    signal?.addEventListener('abort', abort, { once: true });

    connectReq.once('connect', (res, socket, head) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        socket.destroy();
        rejectOnce(new Error(`remote config proxy connect failed: ${res.statusCode ?? 0}`));
        return;
      }
      if (head.length > 0) socket.unshift(head);

      tunneledRequest = httpsRequest(
        {
          hostname: target.hostname,
          port: Number(target.port || 443),
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            ...headers
          },
          createConnection: () => tlsConnect({ socket, servername: target.hostname })
        },
        (response) => {
          responseStarted = true;
          void readIncomingMessageTextBounded(response, {
            maxBytes: EXTERNAL_RESPONSE_BODY_LIMITS.remoteConfigJson,
            scope: 'remote config',
            signal
          }).then(
            (raw) =>
              resolveOnce({
                ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
                status: response.statusCode ?? 0,
                body: parseJson(raw)
              }),
            (cause: unknown) => rejectOnce(new Error('remote config response aborted', { cause }))
          );
        }
      );
      tunneledRequest.setTimeout(timeoutMs, () =>
        tunneledRequest?.destroy(new Error('remote config request timed out'))
      );
      tunneledRequest.once('error', (error) => {
        if (!responseStarted) rejectOnce(error);
      });
      tunneledRequest.end();
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('remote config proxy connect timed out')));
    connectReq.once('error', rejectOnce);
    connectReq.end();
  });
}

async function getJsonViaHttpProxy(
  target: URL,
  proxy: URL,
  authHeaders: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RawJsonResponse> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let req: ReturnType<typeof httpRequest> | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;

    const cleanupAbort = () => signal?.removeEventListener('abort', abort);
    const resolveOnce = (value: RawJsonResponse) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      response?.destroy();
      req?.destroy();
      reject(error);
    };
    const abort = () => rejectOnce(signal?.reason instanceof Error ? signal.reason : new Error('operation canceled'));

    req = httpRequest(
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
        response = res;
        consumeProxyJsonResponse(res, resolveOnce, rejectOnce, signal);
      }
    );

    const currentRequest = req;
    const onRequestError = (error: Error) => rejectOnce(error);
    signal?.addEventListener('abort', abort, { once: true });
    currentRequest.on('timeout', () => currentRequest.destroy(new Error('remote config request timed out')));
    currentRequest.on('error', onRequestError);
    currentRequest.once('close', () => {
      cleanupAbort();
      currentRequest.removeListener('error', onRequestError);
    });
    currentRequest.end();
  });
}

function consumeProxyJsonResponse(
  response: IncomingMessage,
  resolveOnce: (response: RawJsonResponse) => void,
  rejectOnce: (error: unknown) => void,
  signal?: AbortSignal
): void {
  void readIncomingMessageTextBounded(response, {
    maxBytes: EXTERNAL_RESPONSE_BODY_LIMITS.remoteConfigJson,
    scope: 'remote config',
    signal
  }).then(
    (raw) =>
      resolveOnce({
        ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
        status: response.statusCode ?? 0,
        body: parseJson(raw)
      }),
    (cause: unknown) => rejectOnce(new Error('remote config response aborted', { cause }))
  );
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
