import type { IncomingMessage } from 'node:http';

export type BoundedBodyOptions = {
  maxBytes: number;
  scope: string;
  signal?: AbortSignal;
};

export const EXTERNAL_RESPONSE_BODY_LIMITS = {
  trafficJson: 64 * 1024,
  remoteConfigJson: 256 * 1024,
  subscription: 8 * 1024 * 1024,
  connectivityTrace: 32 * 1024
} as const;

export class ResponseBodyTooLargeError extends Error {
  readonly code = 'RESPONSE_BODY_TOO_LARGE';

  constructor(
    readonly scope: string,
    readonly maxBytes: number
  ) {
    super(`${scope} response exceeds the ${maxBytes}-byte limit`);
    this.name = 'ResponseBodyTooLargeError';
  }
}

export function assertTextByteLengthBounded(text: string, options: BoundedBodyOptions): void {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ResponseBodyTooLargeError(options.scope, maxBytes);
  }
}

export async function readFetchTextBounded(response: Response, options: BoundedBodyOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const declaredLength = parseContentLength(response.headers.get('content-length'), options.scope);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    const error = new ResponseBodyTooLargeError(options.scope, maxBytes);
    await response.body?.cancel(error).catch(() => undefined);
    throw error;
  }

  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const abort = () => {
    const reason = getAbortReason(options.signal);
    void reader.cancel(reason).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  const textChunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (options.signal?.aborted) throw getAbortReason(options.signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) throw new ResponseBodyTooLargeError(options.scope, maxBytes);
      textChunks.push(decoder.decode(value, { stream: true }));
    }
    textChunks.push(decoder.decode());
    return textChunks.join('');
  } catch (error) {
    const reason = options.signal?.aborted ? getAbortReason(options.signal) : error;
    await reader.cancel(reason).catch(() => undefined);
    throw reason;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export async function readIncomingMessageTextBounded(
  response: IncomingMessage,
  options: BoundedBodyOptions
): Promise<string> {
  options.signal?.throwIfAborted();
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const declaredLength = parseContentLength(response.headers['content-length'], options.scope);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    const error = new ResponseBodyTooLargeError(options.scope, maxBytes);
    response.destroy();
    throw error;
  }
  const abort = () => response.destroy();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  const textChunks: string[] = [];
  try {
    for await (const chunk of response) {
      if (options.signal?.aborted) throw getAbortReason(options.signal);
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        const error = new ResponseBodyTooLargeError(options.scope, maxBytes);
        response.destroy();
        throw error;
      }
      textChunks.push(decoder.decode(bytes, { stream: true }));
    }
    if (options.signal?.aborted) throw getAbortReason(options.signal);
    textChunks.push(decoder.decode());
    return textChunks.join('');
  } catch (error) {
    if (!response.destroyed) response.destroy();
    throw options.signal?.aborted ? getAbortReason(options.signal) : error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

function normalizeMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('maxBytes must be a non-negative safe integer');
  return value;
}

function parseContentLength(value: string | string[] | undefined | null, scope: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value) && value.length !== 1) throw new Error(`${scope} response has an invalid Content-Length`);
  const normalized = (Array.isArray(value) ? value[0] : value).trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${scope} response has an invalid Content-Length`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${scope} response has an invalid Content-Length`);
  return parsed;
}

function getAbortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}
