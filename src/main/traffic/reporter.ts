import { hostname } from 'node:os';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { TrafficRegistrationInput } from '../../shared/ipc';
import { createDeviceAuthHeaders } from '../deviceAuth';
import type { TrafficStore } from './store';

type TrafficReporterOptions = {
  store: TrafficStore;
  endpoint: string;
  appVersion: string;
  intervalMs?: number;
  requestTimeoutMs?: number;
  getProxyUrl?: () => string | undefined;
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
};

type TrafficReportResponse = {
  traffic?: {
    totalUpload?: number;
    totalDownload?: number;
  };
};

export class TrafficReporter {
  private timer: ReturnType<typeof setInterval> | undefined;
  private reporting: Promise<void> | undefined;

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

    const deviceSeed = await this.options.store.createDeviceSeed();
    const response = await postJson(
      `${endpoint}/api/activate`,
      {
        name,
        passphrase,
        deviceSeed,
        deviceName: hostname(),
        appVersion: this.options.appVersion,
        platform: process.platform
      },
      options.proxyUrl,
      this.options.requestTimeoutMs
    );

    if (!response.ok) {
      const detail = getResponseError(response.body);
      throw new Error(`traffic activation failed: ${response.status}${detail ? ` ${detail}` : ''}`);
    }

    const data = response.body as ActivateResponse;
    if (!data.userId || !data.deviceId) {
      throw new Error('traffic activation response invalid');
    }

    const identity = await this.options.store.registerIdentity({
      userId: data.userId,
      deviceId: data.deviceId,
      name: data.name ?? name,
      deviceName: hostname()
    });
    await this.reportPending().catch(() => undefined);
    return identity;
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
      (bodyText, url) => createDeviceAuthHeaders('POST', url, bodyText, secret)
    );

    if (!response.ok) {
      const detail = getResponseError(response.body);
      const message = `traffic report failed: ${response.status}${detail ? ` ${detail}` : ''}`;
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

    const accepted = await this.options.store.markReported(upload, download, new Date(), report.id, identityKey);
    if (accepted) {
      await this.options.store.markServerTotals(
        (response.body as TrafficReportResponse).traffic ?? {},
        new Date(),
        identityKey
      );
    }
  }
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

type JsonResponse = {
  ok: boolean;
  status: number;
  body: unknown;
};

async function postJson(
  url: string,
  value: unknown,
  proxyUrl?: string,
  timeoutMs = 15000,
  createAuthHeaders?: (body: string, url: string) => Record<string, string>
): Promise<JsonResponse> {
  const body = JSON.stringify(value);
  const authHeaders = createAuthHeaders?.(body, url) ?? {};
  if (!proxyUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('traffic request timed out')), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body,
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

  return postJsonViaProxy(url, body, proxyUrl, timeoutMs, authHeaders);
}

async function postJsonViaProxy(
  url: string,
  body: string,
  proxyUrl: string,
  timeoutMs: number,
  authHeaders: Record<string, string>
): Promise<JsonResponse> {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
    ...authHeaders
  };

  if (target.protocol === 'https:') {
    return postHttpsJsonViaProxy(target, body, proxy, headers, timeoutMs);
  }

  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;

    const resolveOnce = (value: JsonResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      response?.destroy();
      req?.destroy();
      reject(error);
    };
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
        consumeJsonResponse(res, resolveOnce, rejectOnce);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('traffic request timed out')));
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
  timeoutMs: number
): Promise<JsonResponse> {
  const port = target.port || '443';
  const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
    const connectReq = httpRequest({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`
    });

    connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error('traffic proxy connect timed out')));
    connectReq.once('connect', (res, rawSocket) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        rawSocket.destroy();
        reject(new Error(`traffic proxy connect failed: ${res.statusCode ?? 0}`));
        return;
      }
      resolve(rawSocket);
    });
    connectReq.once('error', reject);
    connectReq.end();
  });

  const tlsSocket = tlsConnect({
    socket,
    servername: target.hostname
  });

  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;

    const resolveOnce = (value: JsonResponse) => {
      if (settled) return;
      settled = true;
      tlsSocket.setTimeout(0);
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      response?.destroy();
      req?.destroy();
      tlsSocket.destroy();
      socket.destroy();
      reject(error);
    };
    const onTlsError = (error: Error) => rejectOnce(error);

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
            consumeJsonResponse(res, resolveOnce, rejectOnce);
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
  resolveOnce: (response: JsonResponse) => void,
  rejectOnce: (error: unknown) => void
) {
  const chunks: Buffer[] = [];

  const cleanupReadableListeners = () => {
    response.removeListener('data', onData);
    response.removeListener('end', onEnd);
    response.removeListener('aborted', onAborted);
  };
  const cleanupAllListeners = () => {
    cleanupReadableListeners();
    response.removeListener('error', onError);
    response.removeListener('close', onClose);
  };
  const fail = (cause?: unknown) => {
    cleanupReadableListeners();
    rejectOnce(new Error('traffic response aborted', cause === undefined ? undefined : { cause }));
  };
  const onData = (chunk: Buffer | string) => chunks.push(Buffer.from(chunk));
  const onEnd = () => {
    cleanupReadableListeners();
    const raw = Buffer.concat(chunks).toString('utf8');
    resolveOnce({
      ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
      status: response.statusCode ?? 0,
      body: parseJson(raw)
    });
  };
  const onAborted = () => fail();
  const onError = (error: Error) => fail(error);
  const onClose = () => {
    if (!response.complete) fail();
    cleanupAllListeners();
  };

  response.on('data', onData);
  response.on('end', onEnd);
  response.on('aborted', onAborted);
  response.on('error', onError);
  response.on('close', onClose);
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
