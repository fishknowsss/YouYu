export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type NetworkRoute = 'direct' | 'proxy';

export type NetworkFallbackResponse<T> = {
  response: T;
  route: NetworkRoute;
  directOutcome?: string;
};

type RouteContext = {
  signal: AbortSignal;
  timeoutMs: number;
};

type DirectRouteContext = RouteContext & {
  fetch: FetchLike;
};

type ProxyRouteContext = RouteContext & {
  proxyUrl: string;
};

type NetworkFallbackOptions<T> = {
  scope: string;
  proxyUrl?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: FetchLike;
  getStatus: (response: T) => number;
  direct: (context: DirectRouteContext) => Promise<T>;
  proxy: (context: ProxyRouteContext) => Promise<T>;
};

const retryableStatuses = new Set([408, 502, 503, 504]);
const transportCodes = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'DIRECT_ROUTE_TIMEOUT',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_NETWORK',
  'ERR_SOCKET_CLOSED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
]);

export async function runNetworkFallback<T>(options: NetworkFallbackOptions<T>): Promise<NetworkFallbackResponse<T>> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const deadline = Date.now() + timeoutMs;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(new Error(`${options.scope} timed out`)), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  let route: NetworkRoute = 'direct';
  let directOutcome: string | undefined;

  try {
    options.signal?.throwIfAborted();
    const directRouteController = options.proxyUrl ? new AbortController() : undefined;
    const directRouteTimeoutMs = directRouteController ? getDirectRouteTimeout(timeoutMs) : timeoutMs;
    const directRouteTimeout = directRouteController
      ? setTimeout(() => {
          const error = Object.assign(new Error(`${options.scope} direct route timed out`), {
            code: 'DIRECT_ROUTE_TIMEOUT'
          });
          directRouteController.abort(error);
        }, directRouteTimeoutMs)
      : undefined;
    const directSignal = directRouteController ? AbortSignal.any([signal, directRouteController.signal]) : signal;
    let directResponse: T;
    try {
      directResponse = await options.direct({
        fetch: options.fetch ?? globalThis.fetch,
        signal: directSignal,
        timeoutMs: directRouteTimeoutMs
      });
    } finally {
      if (directRouteTimeout) clearTimeout(directRouteTimeout);
    }
    const directStatus = options.getStatus(directResponse);
    if (!options.proxyUrl || !retryableStatuses.has(directStatus)) {
      return { response: directResponse, route };
    }

    directOutcome = httpOutcome(directStatus);
    route = 'proxy';
    const proxyResponse = await options.proxy({
      proxyUrl: options.proxyUrl,
      signal,
      timeoutMs: remainingTimeout(deadline)
    });
    return { response: proxyResponse, route, directOutcome };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;

    if (route === 'direct' && options.proxyUrl && !timeoutController.signal.aborted && isTransportError(error)) {
      directOutcome = classifyErrorCode(error);
      route = 'proxy';
      try {
        const proxyResponse = await options.proxy({
          proxyUrl: options.proxyUrl,
          signal,
          timeoutMs: remainingTimeout(deadline)
        });
        return { response: proxyResponse, route, directOutcome };
      } catch (proxyError) {
        if (options.signal?.aborted) throw options.signal.reason;
        throw createSafeNetworkError(options.scope, route, proxyError, timeoutController.signal.aborted, directOutcome);
      }
    }

    throw createSafeNetworkError(options.scope, route, error, timeoutController.signal.aborted, directOutcome);
  } finally {
    clearTimeout(timeout);
  }
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function httpOutcome(status: number): string {
  const safeStatus = Number.isFinite(status) ? Math.max(0, Math.floor(status)) : 0;
  return `HTTP_${safeStatus}`;
}

function getDirectRouteTimeout(totalTimeoutMs: number): number {
  const proportional = Math.max(1, Math.floor(totalTimeoutMs * 0.6));
  if (totalTimeoutMs < 2000) return Math.max(1, Math.min(totalTimeoutMs - 1, proportional));
  return Math.min(totalTimeoutMs - 500, Math.max(1000, proportional));
}

function isTransportError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;

  const code = getErrorCode(error);
  if (code && (transportCodes.has(code) || code.startsWith('ERR_TLS_'))) return true;

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('request timed out') ||
    message.includes('connect timed out') ||
    message.includes('response aborted') ||
    message.includes('socket hang up')
  );
}

function createSafeNetworkError(
  scope: string,
  route: NetworkRoute,
  error: unknown,
  timedOut: boolean,
  directOutcome?: string
): Error {
  const code = timedOut ? 'TIMEOUT' : classifyErrorCode(error);
  const originalMessage = error instanceof Error ? error.message : '';
  const safeOriginalMessage =
    /^(?:traffic|remote config) (?:request|proxy connect|response) (?:timed out|aborted)$/i.test(originalMessage)
      ? originalMessage
      : undefined;
  const summary = safeOriginalMessage ?? (code === 'TIMEOUT' ? `${scope} timed out` : `${scope} failed`);
  const fallbackOutcomes = directOutcome ? ` direct=${directOutcome} proxy=${code}` : '';
  return new Error(`${summary}: route=${route} code=${code}${fallbackOutcomes}`);
}

function classifyErrorCode(error: unknown): string {
  const code = getErrorCode(error);
  if (code) return sanitizeCode(code);

  const message = error instanceof Error ? error.message : '';
  if (/response aborted/i.test(message)) return 'RESPONSE_ABORTED';
  if (/timed out/i.test(message)) return 'TIMEOUT';
  const proxyStatus = message.match(/proxy connect failed:\s*(\d{3})/i)?.[1];
  if (proxyStatus) return `PROXY_CONNECT_${proxyStatus}`;
  if (error instanceof TypeError) return 'FETCH_FAILED';
  if (error instanceof DOMException && error.name === 'AbortError') return 'ABORTED';
  return 'REQUEST_FAILED';
}

function getErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function sanitizeCode(code: string): string {
  const normalized = code
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 48);
  return normalized || 'REQUEST_FAILED';
}
