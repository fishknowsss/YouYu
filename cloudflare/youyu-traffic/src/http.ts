export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff'
    }
  });
}

export function staticAsset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      'cache-control': 'no-store, no-transform',
      'content-type': contentType,
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff'
    }
  });
}

export function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      allow: 'GET, POST, OPTIONS'
    }
  });
}

export async function readRequestTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && !/^(?:0|[1-9]\d*)$/.test(declaredLength.trim())) {
    await request.body?.cancel('invalid content length').catch(() => undefined);
    throw new HttpError(400, 'invalid content length');
  }
  if (declaredLength !== null && (!Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > maxBytes)) {
    await request.body?.cancel('request too large').catch(() => undefined);
    throw new HttpError(413, 'request too large');
  }

  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const segments: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel('request too large').catch(() => undefined);
        throw new HttpError(413, 'request too large');
      }

      try {
        segments.push(decoder.decode(value, { stream: true }));
      } catch {
        await reader.cancel('invalid utf-8').catch(() => undefined);
        throw new HttpError(400, 'invalid json');
      }
    }

    try {
      segments.push(decoder.decode());
    } catch {
      throw new HttpError(400, 'invalid json');
    }
    return segments.join('');
  } catch (error) {
    if (!(error instanceof HttpError)) {
      await reader.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readJsonObjectWithLimit(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  await requireJsonMediaType(request);
  const bodyText = await readRequestTextWithLimit(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new HttpError(400, 'invalid json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid json');
  }
  return parsed as Record<string, unknown>;
}

export async function requireJsonMediaType(request: Request): Promise<void> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType)) return;
  await request.body?.cancel('unsupported media type').catch(() => undefined);
  throw new HttpError(415, 'unsupported media type');
}

export async function requireEmptyBody(request: Request): Promise<void> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && !/^(?:0|[1-9]\d*)$/.test(declaredLength.trim())) {
    await request.body?.cancel('invalid content length').catch(() => undefined);
    throw new HttpError(400, 'invalid content length');
  }
  if (declaredLength !== null && Number(declaredLength) > 0) {
    await request.body?.cancel('unexpected request body').catch(() => undefined);
    throw new HttpError(400, 'unexpected request body');
  }
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    if (!first.done && first.value.byteLength > 0) {
      await reader.cancel('unexpected request body').catch(() => undefined);
      throw new HttpError(400, 'unexpected request body');
    }
  } finally {
    reader.releaseLock();
  }
}

export function assertOnlyFields(input: object, supportedFields: string[], errorMessage: string): void {
  const supported = new Set(supportedFields);
  if (Object.keys(input).some((field) => !supported.has(field))) throw new HttpError(400, errorMessage);
}

export class HttpError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.code = errorCodeFor(status, message);
  }
}

function errorCodeFor(status: number, message: string): string {
  const knownCodes: Record<string, string> = {
    'admin disabled': 'ADMIN_DISABLED',
    'config conflict': 'CONFIG_CONFLICT',
    'config request conflict': 'CONFIG_REQUEST_CONFLICT',
    'config request in progress': 'CONFIG_REQUEST_IN_PROGRESS',
    'managed config editing forbidden': 'MANAGED_CONFIG_EDITING_FORBIDDEN',
    'device state changed': 'DEVICE_STATE_CHANGED',
    forbidden: 'FORBIDDEN',
    'internal error': 'INTERNAL_ERROR',
    'invalid app version': 'INVALID_APP_VERSION',
    'invalid config resolution': 'INVALID_CONFIG_RESOLUTION',
    'invalid managed config permission': 'INVALID_MANAGED_CONFIG_PERMISSION',
    'invalid content length': 'INVALID_CONTENT_LENGTH',
    'invalid device': 'INVALID_DEVICE',
    'invalid device key': 'INVALID_DEVICE_KEY',
    'invalid device name': 'INVALID_DEVICE_NAME',
    'invalid download delta': 'INVALID_DOWNLOAD_DELTA',
    'invalid enabled': 'INVALID_ENABLED',
    'invalid identity': 'INVALID_IDENTITY',
    'invalid json': 'INVALID_JSON',
    'invalid name': 'INVALID_NAME',
    'invalid notice enabled': 'INVALID_NOTICE_ENABLED',
    'invalid notice duration': 'INVALID_NOTICE_DURATION',
    'invalid notice expiry': 'INVALID_NOTICE_EXPIRY',
    'invalid notice message': 'INVALID_NOTICE_MESSAGE',
    'invalid notice revision': 'INVALID_NOTICE_REVISION',
    'invalid notice tone': 'INVALID_NOTICE_TONE',
    'invalid notice users': 'INVALID_NOTICE_USERS',
    'too many notice users': 'TOO_MANY_NOTICE_USERS',
    'invalid pagination': 'INVALID_PAGINATION',
    'invalid passphrase': 'INVALID_PASSPHRASE',
    'invalid platform': 'INVALID_PLATFORM',
    'invalid request id': 'INVALID_REQUEST_ID',
    'invalid report id': 'INVALID_REPORT_ID',
    'invalid reported at': 'INVALID_REPORTED_AT',
    'invalid rule profile': 'INVALID_RULE_PROFILE',
    'invalid preferred region': 'INVALID_PREFERRED_REGION',
    'invalid region fallback': 'INVALID_REGION_FALLBACK',
    'invalid signature': 'INVALID_SIGNATURE',
    'invalid subscription url': 'INVALID_SUBSCRIPTION_URL',
    'invalid target user': 'INVALID_TARGET_USER',
    'invalid traffic expiry': 'INVALID_TRAFFIC_EXPIRY',
    'invalid traffic limit': 'INVALID_TRAFFIC_LIMIT',
    'invalid traffic period': 'INVALID_TRAFFIC_PERIOD',
    'invalid traffic period start': 'INVALID_TRAFFIC_PERIOD_START',
    'invalid traffic trend range': 'INVALID_TRAFFIC_TREND_RANGE',
    'invalid user': 'INVALID_USER',
    'invalid user merge': 'INVALID_USER_MERGE',
    'merge request conflict': 'MERGE_REQUEST_CONFLICT',
    'merge state changed': 'MERGE_STATE_CHANGED',
    'missing device': 'MISSING_DEVICE',
    'missing identity': 'MISSING_IDENTITY',
    'missing name': 'MISSING_NAME',
    'missing report id': 'MISSING_REPORT_ID',
    'not found': 'NOT_FOUND',
    'name conflict': 'NAME_CONFLICT',
    'notice state changed': 'NOTICE_STATE_CHANGED',
    'notice request conflict': 'NOTICE_REQUEST_CONFLICT',
    'profile request conflict': 'PROFILE_REQUEST_CONFLICT',
    'profile state changed': 'PROFILE_STATE_CHANGED',
    'registration conflict': 'REGISTRATION_CONFLICT',
    'registration disabled': 'REGISTRATION_DISABLED',
    'report id conflict': 'REPORT_ID_CONFLICT',
    'request too large': 'REQUEST_TOO_LARGE',
    'same user': 'SAME_USER',
    'signature required': 'SIGNATURE_REQUIRED',
    'stale signature': 'STALE_SIGNATURE',
    'too many attempts': 'TOO_MANY_ATTEMPTS',
    'unexpected request body': 'UNEXPECTED_REQUEST_BODY',
    'unknown device': 'UNKNOWN_DEVICE',
    'unknown target user': 'UNKNOWN_TARGET_USER',
    'unknown user': 'UNKNOWN_USER',
    'unsupported activation field': 'UNSUPPORTED_ACTIVATION_FIELD',
    'unsupported config field': 'UNSUPPORTED_CONFIG_FIELD',
    'unsupported config permission field': 'UNSUPPORTED_CONFIG_PERMISSION_FIELD',
    'unsupported merge field': 'UNSUPPORTED_MERGE_FIELD',
    'unsupported notice acknowledgement field': 'UNSUPPORTED_NOTICE_ACKNOWLEDGEMENT_FIELD',
    'unsupported notice field': 'UNSUPPORTED_NOTICE_FIELD',
    'unsupported profile field': 'UNSUPPORTED_PROFILE_FIELD',
    'unsupported media type': 'UNSUPPORTED_MEDIA_TYPE',
    'unsupported traffic report field': 'UNSUPPORTED_TRAFFIC_REPORT_FIELD',
    'unsupported traffic limit field': 'UNSUPPORTED_TRAFFIC_LIMIT_FIELD',
    'user already merged': 'USER_ALREADY_MERGED',
    'invalid upload delta': 'INVALID_UPLOAD_DELTA'
  };
  return knownCodes[message] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED');
}
