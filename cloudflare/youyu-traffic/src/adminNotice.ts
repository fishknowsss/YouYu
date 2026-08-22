const USER_NOTICE_MAX_MESSAGE_LENGTH = 500;
const USER_NOTICE_DEFAULT_DURATION_MINUTES = 10;
const USER_NOTICE_MIN_DURATION_MINUTES = 5;
const USER_NOTICE_DURATION_STEP_MINUTES = 5;
const USER_NOTICE_MAX_DURATION_MINUTES = 7 * 24 * 60;
const USER_NOTICE_BROADCAST_MAX_USERS = 200;

type AdminNoticeBoundaryOptions = {
  createHttpError: (status: number, message: string) => Error;
  assertOnlyFields: (value: object, fields: string[], message: string) => void;
  isUuid: (value: string) => boolean;
  randomUuid: () => string;
  sha256Hex: (value: string) => Promise<string>;
};

type AdminNoticeUpdateInput = {
  enabled?: unknown;
  message?: unknown;
  tone?: unknown;
  durationMinutes?: unknown;
  requestId?: unknown;
};

type AdminNoticeBroadcastInput = {
  userIds?: unknown;
  message?: unknown;
  tone?: unknown;
  durationMinutes?: unknown;
  requestId?: unknown;
};

type AdminNoticeResetInput = {
  userIds?: unknown;
  requestId?: unknown;
};

export function createAdminNoticeBoundary(options: AdminNoticeBoundaryOptions) {
  const fail = (message: string): never => {
    throw options.createHttpError(400, message);
  };

  function parseMessage(value: unknown): string {
    if (typeof value !== 'string') return fail('invalid notice message');
    const message = value.trim();
    if (!message || !isBoundedText(message, USER_NOTICE_MAX_MESSAGE_LENGTH)) {
      return fail('invalid notice message');
    }
    return message;
  }

  function parseTone(value: unknown): 'info' | 'warning' {
    if (value === 'info' || value === 'warning') return value;
    return fail('invalid notice tone');
  }

  function parseDurationMinutes(value: unknown): number {
    if (value === undefined) return USER_NOTICE_DEFAULT_DURATION_MINUTES;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < USER_NOTICE_MIN_DURATION_MINUTES ||
      value > USER_NOTICE_MAX_DURATION_MINUTES ||
      value % USER_NOTICE_DURATION_STEP_MINUTES !== 0
    ) {
      return fail('invalid notice duration');
    }
    return value;
  }

  function parseUserIds(value: unknown): string[] {
    if (!Array.isArray(value)) return fail('invalid notice users');
    const seen = new Set<string>();
    const userIds: string[] = [];
    for (const entry of value) {
      const userId = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
      if (!userId || !options.isUuid(userId)) return fail('invalid notice users');
      if (seen.has(userId)) continue;
      seen.add(userId);
      userIds.push(userId);
    }
    if (!userIds.length) return fail('invalid notice users');
    if (userIds.length > USER_NOTICE_BROADCAST_MAX_USERS) return fail('too many notice users');
    return userIds;
  }

  function parseRequestId(value: unknown): string {
    const requestId = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : options.randomUuid();
    if (!options.isUuid(requestId)) return fail('invalid request id');
    return requestId;
  }

  function parseUpdate(input: AdminNoticeUpdateInput) {
    options.assertOnlyFields(
      input,
      ['enabled', 'message', 'tone', 'durationMinutes', 'requestId'],
      'unsupported notice field'
    );
    if (typeof input.enabled !== 'boolean') return fail('invalid notice enabled');
    return {
      enabled: input.enabled,
      message: parseMessage(input.message),
      tone: parseTone(input.tone),
      durationMinutes: parseDurationMinutes(input.durationMinutes),
      requestId: parseRequestId(input.requestId)
    };
  }

  function parseBroadcast(input: AdminNoticeBroadcastInput) {
    options.assertOnlyFields(
      input,
      ['userIds', 'message', 'tone', 'durationMinutes', 'requestId'],
      'unsupported notice field'
    );
    return {
      operation: 'broadcast' as const,
      userIds: parseUserIds(input.userIds),
      message: parseMessage(input.message),
      tone: parseTone(input.tone),
      durationMinutes: parseDurationMinutes(input.durationMinutes),
      requestId: parseRequestId(input.requestId)
    };
  }

  function parseReset(input: AdminNoticeResetInput) {
    options.assertOnlyFields(input, ['userIds', 'requestId'], 'unsupported notice field');
    return {
      operation: 'reset' as const,
      userIds: parseUserIds(input.userIds),
      requestId: parseRequestId(input.requestId)
    };
  }

  async function hashBatchPayload(
    input:
      | ReturnType<typeof parseBroadcast>
      | ReturnType<typeof parseReset>
      | {
          operation: 'broadcast' | 'reset';
          userIds: string[];
          message?: string;
          tone?: 'info' | 'warning';
          durationMinutes?: number;
        }
  ): Promise<string> {
    const payload = {
      operation: input.operation,
      userIds: [...input.userIds].sort(),
      ...('message' in input ? { message: input.message } : {}),
      ...('tone' in input ? { tone: input.tone } : {}),
      ...('durationMinutes' in input ? { durationMinutes: input.durationMinutes } : {})
    };
    return options.sha256Hex(JSON.stringify(payload));
  }

  async function deriveRequestId(batchRequestId: string, userId: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${batchRequestId}:${userId}`));
    const bytes = new Uint8Array(digest).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function normalizeStoredDurationMinutes(value: unknown): number {
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= USER_NOTICE_MIN_DURATION_MINUTES &&
      value <= USER_NOTICE_MAX_DURATION_MINUTES &&
      value % USER_NOTICE_DURATION_STEP_MINUTES === 0
      ? value
      : USER_NOTICE_DEFAULT_DURATION_MINUTES;
  }

  function parseRevision(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      return fail('invalid notice revision');
    }
    return value;
  }

  return {
    parseUpdate,
    parseBroadcast,
    parseReset,
    hashBatchPayload,
    deriveRequestId,
    normalizeStoredDurationMinutes,
    parseRevision
  };
}

function isBoundedText(value: string, maxLength: number): boolean {
  return Array.from(value).length <= maxLength && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}
