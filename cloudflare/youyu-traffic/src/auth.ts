type WorkerAuthOptions<Environment> = {
  getAdminToken: (env: Environment) => string | undefined;
  getClientIp: (request: Request) => string;
  consumeRateLimitAttempt: (env: Environment, key: string, maxAttempts: number, windowMs: number) => Promise<void>;
  clearRateLimit: (env: Environment, key: string) => Promise<void>;
  resolveCanonicalUserId: (env: Environment, requestedUserId: string) => Promise<string>;
  findDeviceSeed: (env: Environment, deviceId: string, canonicalUserId: string) => Promise<string | undefined>;
  createHttpError: (status: number, message: string) => Error;
  getHttpErrorStatus?: (error: unknown) => number | undefined;
  now?: () => number;
  deviceFailureLimit: number;
  deviceFailureWindowMs: number;
};

export function createWorkerAuth<Environment>(options: WorkerAuthOptions<Environment>) {
  const now = options.now ?? Date.now;

  async function requireAdmin(request: Request, env: Environment): Promise<void> {
    const expectedToken = options.getAdminToken(env)?.trim();
    if (!expectedToken) throw options.createHttpError(403, 'admin disabled');
    const token = request.headers
      .get('authorization')
      ?.replace(/^Bearer\s+/i, '')
      .trim();
    if (constantTimeEqual(token ?? '', expectedToken)) return;

    const rateLimitKey = `admin:${options.getClientIp(request)}`;
    await options.consumeRateLimitAttempt(env, rateLimitKey, 10, 15 * 60 * 1000);
    throw options.createHttpError(403, 'forbidden');
  }

  async function verifyDeviceRequest(
    request: Request,
    env: Environment,
    userId: string,
    deviceId: string,
    bodyText: string,
    requestId?: string
  ): Promise<string> {
    if (!isUuid(userId) || !isUuid(deviceId)) throw options.createHttpError(400, 'invalid identity');
    const timestamp = request.headers.get('x-youyu-timestamp')?.trim() ?? '';
    const signature = request.headers.get('x-youyu-signature')?.trim() ?? '';
    if (!timestamp || !signature) throw options.createHttpError(401, 'signature required');
    if (!/^\d{10,16}$/.test(timestamp)) throw options.createHttpError(401, 'stale signature');
    if (!/^[0-9a-f]{64}$/i.test(signature)) throw options.createHttpError(401, 'invalid signature');

    const requestTime = Number(timestamp);
    if (!Number.isFinite(requestTime) || Math.abs(now() - requestTime) > 5 * 60 * 1000) {
      throw options.createHttpError(401, 'stale signature');
    }

    const rateLimitKey = `device-auth:${options.getClientIp(request)}:${deviceId}`;
    await options.consumeRateLimitAttempt(env, rateLimitKey, options.deviceFailureLimit, options.deviceFailureWindowMs);
    try {
      const canonicalUserId = await options.resolveCanonicalUserId(env, userId);
      const deviceSeed = await options.findDeviceSeed(env, deviceId, canonicalUserId);
      if (!deviceSeed) throw options.createHttpError(403, 'unknown device');

      const expected = await signDeviceRequest(
        request.method,
        new URL(request.url),
        bodyText,
        deviceSeed,
        timestamp,
        requestId
      );
      if (!constantTimeEqual(signature, expected)) throw options.createHttpError(401, 'invalid signature');
      await options.clearRateLimit(env, rateLimitKey);
      return canonicalUserId;
    } catch (error) {
      const status = options.getHttpErrorStatus?.(error);
      if (status !== 401 && status !== 403) {
        await options.clearRateLimit(env, rateLimitKey).catch(() => undefined);
      }
      throw error;
    }
  }

  return { requireAdmin, verifyDeviceRequest };
}

export async function signDeviceRequest(
  method: string,
  url: URL,
  bodyText: string,
  secret: string,
  timestamp: string,
  requestId?: string
): Promise<string> {
  const canonicalParts = [method.toUpperCase(), `${url.pathname}${url.search}`, timestamp];
  if (requestId) canonicalParts.push(requestId);
  canonicalParts.push(await sha256Hex(bodyText));
  const canonical = canonicalParts.join('\n');
  return hmacSha256Hex(secret, canonical);
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}
