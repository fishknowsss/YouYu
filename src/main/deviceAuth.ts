import { createHash, createHmac } from 'node:crypto';

const timestampHeader = 'x-youyu-timestamp';
const signatureHeader = 'x-youyu-signature';

export function createDeviceAuthHeaders(
  method: string,
  url: string,
  body: string,
  secret: string,
  now = Date.now()
): Record<string, string> {
  const timestamp = String(now);
  return {
    [timestampHeader]: timestamp,
    [signatureHeader]: signDeviceRequest(method, url, body, secret, timestamp)
  };
}

function signDeviceRequest(method: string, url: string, body: string, secret: string, timestamp: string): string {
  const target = new URL(url);
  const canonical = [
    method.toUpperCase(),
    `${target.pathname}${target.search}`,
    timestamp,
    createHash('sha256').update(body).digest('hex')
  ].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
