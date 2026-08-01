import { hostname } from 'node:os';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { TrafficRegistrationInput } from '../../shared/ipc';
import { createDeviceAuthHeaders } from '../deviceAuth';
import {
  EXTERNAL_RESPONSE_BODY_LIMITS,
  readFetchTextBounded,
  readIncomingMessageTextBounded
} from '../http/boundedBody';
import { runNetworkFallback, type FetchLike, type NetworkRoute } from '../networkFallback';
import type { TrafficStore } from './store';

type TrafficReporterOptions = {
  store: TrafficStore;
  endpoint: string;
  appVersion: string;
  intervalMs?: number;
  requestTimeoutMs?: number;
  fetch?: FetchLike;
  getProxyUrl?: () => string | undefined;
  getDeviceKey?: () => Promise<string | undefined>;
  onIdentityInvalidated?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
};

type RegisterOptions = {
  proxyUrl?: string;
};

type ActivateResponse = {
  userId?: string;
  deviceId?: string;
  name?: string;
  traffic?: {
    totalUpload?: number;
    totalDownload?: number;
    todayUpload?: number;
    todayDownload?: number;
    date?: string;
  };
};

type TrafficReportResponse = {
  ok: true;
  traffic: {
    totalUpload: number;
    totalDownload: number;
    todayUpload?: number;
    todayDownload?: number;
    date?: string;
  };
};

export class TrafficReporter {
  private timer: ReturnType<typeof setInterval> | undefined;
  private reporting: Promise<void> | undefined;
  private latestRegistrationAttempt = 0;
  private registrationCommitQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: TrafficReporterOptions) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () => {
        void this.reportPending().catch((error) => this.options.onError?.(error));
      },
      this.options.intervalMs ?? 10 * 60 * 1000
    );
    void this.reportPending().catch((error) => this.options.onError?.(error));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async register(input: TrafficRegistrationInput, options: RegisterOptions = {}) {
    const endpoint = normalizeEndpoint(this.options.endpoint);
    if (!endpoint) {
      await this.options.store.markNotConfigured();
      throw new Error('traffic endpoint not configured');
    }

    const name = input.name.trim();
    const passphrase = input.passphrase.trim();
    if (!name) throw new Error('missing traffic user name');
    if (!passphrase) throw new Error('missing traffic passphrase');
    const registrationAttempt = ++this.latestRegistrationAttempt;

    const deviceSeed = await this.options.store.createDeviceSeed();
    const deviceKey = await getOptionalDeviceKey(this.options.getDeviceKey);
    this.assertCurrentRegistration(registrationAttempt);
    const response = await postJson(
      `${endpoint}/api/activate`,
      {
        name,
        passphrase,
        deviceSeed,
        ...(deviceKey ? { deviceKey } : {}),
        deviceName: hostname(),
        appVersion: this.options.appVersion,
        platform: process.platform
      },
      options.proxyUrl,
      this.options.requestTimeoutMs,
      undefined,
      this.options.fetch
    );
    this.assertCurrentRegistration(registrationAttempt);

    if (!response.ok) {
      const detail = getResponseError(response.body);
      throw new Error(
        `traffic activation failed: ${response.status}${detail ? ` ${detail}` : ''} (${responseRouteDetails(response)})`
      );
    }

    const data = response.body as ActivateResponse;
    const traffic = data.traffic;
    if (
      !data.userId ||
      !data.deviceId ||
      !traffic ||
      !isNonNegativeNumber(traffic.totalUpload) ||
      !isNonNegativeNumber(traffic.totalDownload) ||
      !isNonNegativeNumber(traffic.todayUpload) ||
      !isNonNegativeNumber(traffic.todayDownload) ||
      typeof traffic.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(traffic.date)
    ) {
      throw new Error(`traffic activation response invalid (${responseRouteDetails(response)})`);
    }

    const activated = await this.commitRegistration(registrationAttempt, () =>
      this.options.store.activateIdentity(
        {
          userId: data.userId!,
          deviceId: data.deviceId!,
          name: data.name ?? name,
          deviceName: hostname()
        },
        {
          totalUpload: traffic.totalUpload!,
          totalDownload: traffic.totalDownload!,
          todayUpload: traffic.todayUpload!,
          todayDownload: traffic.todayDownload!,
          date: traffic.date!
        },
        new Date(),
        deviceSeed
      )
    );
    if (activated.pendingUpload > 0 || activated.pendingDownload > 0) {
      this.assertCurrentRegistration(registrationAttempt);
      await this.reportPending().catch(() => undefined);
      this.assertCurrentRegistration(registrationAttempt);
    }
    return activated.identity;
  }

  private assertCurrentRegistration(registrationAttempt: number): void {
    if (registrationAttempt === this.latestRegistrationAttempt) return;
    throw Object.assign(new Error('本次流量登记已被较新的操作取代'), {
      code: 'REGISTRATION_SUPERSEDED'
    });
  }

  private commitRegistration<T>(registrationAttempt: number, commit: () => Promise<T>): Promise<T> {
    const result = this.registrationCommitQueue.then(async () => {
      this.assertCurrentRegistration(registrationAttempt);
      const committed = await commit();
      this.assertCurrentRegistration(registrationAttempt);
      return committed;
    });
    this.registrationCommitQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async reportPending() {
    if (this.reporting) return this.reporting;
    const reporting = this.reportPendingOnce();
    this.reporting = reporting;
    try {
      await reporting;
    } finally {
      if (this.reporting === reporting) this.reporting = undefined;
    }
  }

  private async reportPendingOnce() {
    const endpoint = normalizeEndpoint(this.options.endpoint);
    const { identity, stats } = await this.options.store.getSnapshot();
    if (!endpoint) {
      await this.options.store.markNotConfigured();
      return;
    }
    if (identity?.verificationStatus === 'pending') return;
    if (!identity) return;
    const identityKey = { userId: identity.userId, deviceId: identity.deviceId };

    const report = await this.options.store.getOrCreatePendingReport(
      stats.pendingUpload,
      stats.pendingDownload,
      new Date(),
      identityKey
    );
    if (!report) return;
    const upload = report.upload;
    const download = report.download;
    const body = {
      reportId: report.id,
      userId: identity.userId,
      deviceId: identity.deviceId,
      uploadDelta: upload,
      downloadDelta: download,
      appVersion: this.options.appVersion,
      reportedAt: report.reportedAt
    };
    const secret = await this.options.store.getDeviceSecret();
    if (!secret) {
      const message = 'traffic device secret missing';
      await this.options.store.markReportFailedIfCurrent(identityKey, report.id, message);
      throw new Error(message);
    }

    const response = await postJson(
      `${endpoint}/api/traffic/report`,
      body,
      this.options.getProxyUrl?.(),
      this.options.requestTimeoutMs,
      (bodyText, url) => createDeviceAuthHeaders('POST', url, bodyText, secret),
      this.options.fetch
    );

    if (!response.ok) {
      const detail = getResponseError(response.body);
      const message = `traffic report failed: ${response.status}${detail ? ` ${detail}` : ''} (${responseRouteDetails(response)})`;
      if (response.status === 403 && detail.trim().toLowerCase() === 'unknown device') {
        const cleared = await this.options.store.clearIdentityIfCurrent(identityKey, report.id, message);
        if (cleared) {
          try {
            await this.options.onIdentityInvalidated?.();
          } catch (error) {
            try {
              this.options.onError?.(error);
            } catch {
              // Keep the backend rejection as the observable reporting error.
            }
          }
        }
      } else {
        await this.options.store.markReportFailedIfCurrent(identityKey, report.id, message);
      }
      throw new Error(message);
    }

    const data = parseTrafficReportResponse(response.body);
    if (!data) {
      const message = `traffic report response invalid (${responseRouteDetails(response)})`;
      await this.options.store.markReportFailedIfCurrent(identityKey, report.id, message);
      throw new Error(message);
    }

    const accepted = await this.options.store.markReported(upload, download, new Date(), report.id, identityKey);
    if (accepted) {
      await this.options.store.markServerTotals(data.traffic, new Date(), identityKey, {
        localDayBaseline:
          report.localDate && typeof report.localDayUpload === 'number' && typeof report.localDayDownload === 'number'
            ? {
                date: report.localDate,
                upload: report.localDayUpload,
                download: report.localDayDownload
              }
            : 'current'
      });
    }
  }
}

async function getOptionalDeviceKey(
  provider: (() => Promise<string | undefined>) | undefined
): Promise<string | undefined> {
  if (!provider) return undefined;
  try {
    const value = await provider();
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseTrafficReportResponse(value: unknown): TrafficReportResponse | undefined {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.traffic)) return undefined;
  const traffic = value.traffic;
  if (!isNonNegativeNumber(traffic.totalUpload) || !isNonNegativeNumber(traffic.totalDownload)) return undefined;

  const hasDailyTotals = 'todayUpload' in traffic || 'todayDownload' in traffic || 'date' in traffic;
  if (hasDailyTotals) {
    if (
      !isNonNegativeNumber(traffic.todayUpload) ||
      !isNonNegativeNumber(traffic.todayDownload) ||
      typeof traffic.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(traffic.date)
    ) {
      return undefined;
    }
    return {
      ok: true,
      traffic: {
        totalUpload: traffic.totalUpload,
        totalDownload: traffic.totalDownload,
        todayUpload: traffic.todayUpload,
        todayDownload: traffic.todayDownload,
        date: traffic.date
      }
    };
  }

  return {
    ok: true,
    traffic: {
      totalUpload: traffic.totalUpload,
      totalDownload: traffic.totalDownload
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type JsonResponse = {
  ok: boolean;
  status: number;
  body: unknown;
  route: NetworkRoute;
  directOutcome?: string;
};

type RawJsonResponse = Omit<JsonResponse, 'route' | 'directOutcome'>;

async function postJson(
  url: string,
  value: unknown,
  proxyUrl?: string,
  timeoutMs = 15000,
  createAuthHeaders?: (body: string, url: string) => Record<string, string>,
  fetch?: FetchLike
): Promise<JsonResponse> {
  const body = JSON.stringify(value);
  const authHeaders = createAuthHeaders?.(body, url) ?? {};
  const result = await runNetworkFallback<RawJsonResponse>({
    scope: 'traffic request',
    proxyUrl,
    timeoutMs,
    fetch,
    getStatus: (response) => response.status,
    direct: async ({ fetch: directFetch, signal }) => {
      const response = await directFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body,
        signal
      });
      return {
        ok: response.ok,
        status: response.status,
        body: parseJson(
          await readFetchTextBounded(response, {
            maxBytes: EXTERNAL_RESPONSE_BODY_LIMITS.trafficJson,
            scope: 'traffic',
            signal
          })
        )
      };
    },
    proxy: ({ proxyUrl: fallbackProxyUrl, timeoutMs: remainingMs, signal }) =>
      postJsonViaProxy(url, body, fallbackProxyUrl, remainingMs, authHeaders, signal)
  });
  return { ...result.response, route: result.route, directOutcome: result.directOutcome };
}

function responseRouteDetails(response: JsonResponse): string {
  const current = `route=${response.route} status=${response.status}`;
  return response.directOutcome ? `${current} direct=${response.directOutcome} proxy=HTTP_${response.status}` : current;
}

async function postJsonViaProxy(
  url: string,
  body: string,
  proxyUrl: string,
  timeoutMs: number,
  authHeaders: Record<string, string>,
  signal?: AbortSignal
): Promise<RawJsonResponse> {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
    ...authHeaders
  };

  if (target.protocol === 'https:') {
    return postHttpsJsonViaProxy(target, body, proxy, headers, timeoutMs, signal);
  }

  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;

    const resolveOnce = (value: RawJsonResponse) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      response?.destroy();
      req?.destroy();
      reject(error);
    };
    const abort = () => rejectOnce(signal?.reason instanceof Error ? signal.reason : new Error('operation canceled'));
    const onRequestError = (error: Error) => rejectOnce(error);

    req = httpRequest(
      {
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'POST',
        path: target.href,
        headers
      },
      (res) => {
        response = res;
        consumeJsonResponse(res, resolveOnce, rejectOnce, signal);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('traffic request timed out')));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('error', onRequestError);
    req.once('close', () => req?.removeListener('error', onRequestError));
    req.write(body);
    req.end();
  });
}

async function postHttpsJsonViaProxy(
  target: URL,
  body: string,
  proxy: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RawJsonResponse> {
  const port = target.port || '443';
  const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
    signal?.throwIfAborted();
    let settled = false;
    const connectReq = httpRequest({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`
    });

    const cleanup = () => signal?.removeEventListener('abort', abort);
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      connectReq.destroy();
      reject(error);
    };
    const abort = () => rejectOnce(signal?.reason instanceof Error ? signal.reason : new Error('operation canceled'));

    connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error('traffic proxy connect timed out')));
    connectReq.once('connect', (res, rawSocket) => {
      if (settled) {
        rawSocket.destroy();
        return;
      }
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        rawSocket.destroy();
        rejectOnce(new Error(`traffic proxy connect failed: ${res.statusCode ?? 0}`));
        return;
      }
      settled = true;
      cleanup();
      resolve(rawSocket);
    });
    signal?.addEventListener('abort', abort, { once: true });
    connectReq.once('error', rejectOnce);
    connectReq.end();
  });

  if (signal?.aborted) {
    socket.destroy();
    signal.throwIfAborted();
  }

  const tlsSocket = tlsConnect({
    socket,
    servername: target.hostname
  });

  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;

    const resolveOnce = (value: RawJsonResponse) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      tlsSocket.setTimeout(0);
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      response?.destroy();
      req?.destroy();
      tlsSocket.destroy();
      socket.destroy();
      reject(error);
    };
    const abort = () => rejectOnce(signal?.reason instanceof Error ? signal.reason : new Error('operation canceled'));
    const onTlsError = (error: Error) => rejectOnce(error);

    signal?.addEventListener('abort', abort, { once: true });
    tlsSocket.setTimeout(timeoutMs, () => rejectOnce(new Error('traffic request timed out')));
    tlsSocket.on('error', onTlsError);
    tlsSocket.once('close', () => tlsSocket.removeListener('error', onTlsError));
    tlsSocket.once('secureConnect', () => {
      if (settled) return;
      try {
        req = httpsRequest(
          {
            hostname: target.hostname,
            port,
            method: 'POST',
            path: `${target.pathname}${target.search}`,
            headers,
            createConnection: () => tlsSocket
          },
          (res) => {
            response = res;
            consumeJsonResponse(res, resolveOnce, rejectOnce, signal);
          }
        );

        const currentRequest = req;
        const onRequestError = (error: Error) => rejectOnce(error);
        currentRequest.on('error', onRequestError);
        currentRequest.once('close', () => currentRequest.removeListener('error', onRequestError));
        currentRequest.write(body);
        currentRequest.end();
      } catch (error) {
        rejectOnce(error);
      }
    });
  });
}

function consumeJsonResponse(
  response: IncomingMessage,
  resolveOnce: (response: RawJsonResponse) => void,
  rejectOnce: (error: unknown) => void,
  signal?: AbortSignal
) {
  void readIncomingMessageTextBounded(response, {
    maxBytes: EXTERNAL_RESPONSE_BODY_LIMITS.trafficJson,
    scope: 'traffic',
    signal
  }).then(
    (raw) =>
      resolveOnce({
        ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
        status: response.statusCode ?? 0,
        body: parseJson(raw)
      }),
    (cause: unknown) => rejectOnce(new Error('traffic response aborted', { cause }))
  );
}

function parseJson(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function getResponseError(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' ? error : '';
}
