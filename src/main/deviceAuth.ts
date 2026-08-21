import { createHash, createHmac } from 'node:crypto';

const timestampHeader = 'x-youyu-timestamp';
const signatureHeader = 'x-youyu-signature';
const requestIdHeader = 'x-youyu-request-id';

export function createDeviceAuthHeaders(
  method: string,
  url: string,
  body: string,
  secret: string,
  requestIdOrNow?: string | number
): Record<string, string> {
  const requestId = typeof requestIdOrNow === 'string' ? requestIdOrNow : undefined;
  const now = typeof requestIdOrNow === 'number' ? requestIdOrNow : Date.now();
  const timestamp = String(now);
  return {
    [timestampHeader]: timestamp,
    ...(requestId ? { [requestIdHeader]: requestId } : {}),
    [signatureHeader]: signDeviceRequest(method, url, body, secret, timestamp, requestId)
  };
}

function signDeviceRequest(
  method: string,
  url: string,
  body: string,
  secret: string,
  timestamp: string,
  requestId?: string
): string {
  const target = new URL(url);
  const canonicalParts = [method.toUpperCase(), `${target.pathname}${target.search}`, timestamp];
  if (requestId) canonicalParts.push(requestId);
  canonicalParts.push(createHash('sha256').update(body).digest('hex'));
  const canonical = canonicalParts.join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
