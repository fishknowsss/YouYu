import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
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

export class TrafficReporter {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: TrafficReporterOptions) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reportPending().catch((error) => this.options.onError?.(error));
    }, this.options.intervalMs ?? 10 * 60 * 1000);
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
    const endpoint = normalizeEndpoint(this.options.endpoint);
    const { identity, stats } = await this.options.store.getSnapshot();
    if (!endpoint) {
      await this.options.store.markNotConfigured();
      return;
    }
    if (identity?.verificationStatus === 'pending') return;
    if (!identity || (stats.pendingUpload === 0 && stats.pendingDownload === 0)) return;

    const upload = stats.pendingUpload;
    const download = stats.pendingDownload;
    const body = {
      reportId: randomUUID(),
      userId: identity.userId,
      deviceId: identity.deviceId,
      uploadDelta: upload,
      downloadDelta: download,
      appVersion: this.options.appVersion,
      reportedAt: new Date().toISOString()
    };
    const secret = await this.options.store.getDeviceSecret();
    if (!secret) {
      const message = 'traffic device secret missing';
      await this.options.store.markReportFailed(message);
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
      const message = `traffic report failed: ${response.status}`;
      await this.options.store.markReportFailed(message);
      throw new Error(message);
    }

    await this.options.store.markReported(upload, download);
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
    const req = httpRequest(
      {
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'POST',
        path: target.href,
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
            status: res.statusCode ?? 0,
            body: parseJson(raw)
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('traffic request timed out')));
    req.on('error', reject);
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
  tlsSocket.setTimeout(timeoutMs, () => tlsSocket.destroy(new Error('traffic request timed out')));

  return new Promise((resolve, reject) => {
    tlsSocket.once('error', reject);
    tlsSocket.once('secureConnect', () => {
      const req = httpsRequest(
        {
          hostname: target.hostname,
          port,
          method: 'POST',
          path: `${target.pathname}${target.search}`,
          headers,
          createConnection: () => tlsSocket
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve({
              ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
              status: res.statusCode ?? 0,
              body: parseJson(raw)
            });
          });
        }
      );

      req.once('error', reject);
      req.write(body);
      req.end();
    });
  });
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
