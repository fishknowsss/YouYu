export type RuntimeFailureCode =
  | 'OPERATION_ABORTED'
  | 'ELEVATION_CANCELED'
  | 'SUBSCRIPTION_INVALID'
  | 'CONFIG_INVALID'
  | 'REMOTE_REVISION_STALE'
  | 'CORE_NOT_READY'
  | 'PORT_CONFLICT'
  | 'PROXY_APPLY_FAILED'
  | 'PROXY_RESTORE_REQUIRED'
  | 'SYSTEM_NETWORK_REPAIR_FAILED'
  | 'UNKNOWN';

export class RuntimeOperationError extends Error {
  readonly code: RuntimeFailureCode;

  constructor(code: RuntimeFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeOperationError';
    this.code = code;
  }
}

export type RuntimeFailure = {
  code: RuntimeFailureCode;
  retryable: boolean;
  error: unknown;
};

function inferFailureCode(error: Error): RuntimeFailureCode {
  const message = error.message;
  if (isExpectedOperationCancellation(error)) {
    return 'OPERATION_ABORTED';
  }
  if (/missing subscription url|no usable subscription nodes|subscription (?:invalid|failed)/i.test(message)) {
    return 'SUBSCRIPTION_INVALID';
  }
  if (/remote config changed during mihomo start/i.test(message)) return 'REMOTE_REVISION_STALE';
  if (/YAMLParseError|config(?:uration)? (?:invalid|parse|syntax)|invalid (?:mihomo )?config/i.test(message)) {
    return 'CONFIG_INVALID';
  }
  if (/需要管理员权限|等待管理员授权|管理员操作(?:失败|连接已关闭)|elevation|uac/i.test(message)) {
    return 'ELEVATION_CANCELED';
  }
  if (/Failed to verify current-user proxy after enable|proxy apply failed/i.test(message)) {
    return 'PROXY_APPLY_FAILED';
  }
  if (/proxy (?:rollback|restore|ownership recovery) failed|Failed to restore current-user proxy/i.test(message)) {
    return 'PROXY_RESTORE_REQUIRED';
  }
  if (/System network repair failed/i.test(message)) return 'SYSTEM_NETWORK_REPAIR_FAILED';
  if (/\bEADDRINUSE\b|address already in use|\bbind failed\b/i.test(message)) return 'PORT_CONFLICT';
  if (/mihomo controller not ready/i.test(message)) return 'CORE_NOT_READY';
  return 'UNKNOWN';
}

export function classifyRuntimeFailure(error: unknown): RuntimeFailure {
  const code =
    error instanceof RuntimeOperationError ? error.code : error instanceof Error ? inferFailureCode(error) : 'UNKNOWN';
  return {
    code,
    retryable: code === 'CORE_NOT_READY' || code === 'PORT_CONFLICT',
    error
  };
}

export async function runRuntimeOperationWithSafeRetry<T>(
  operation: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    beforeRetry?: (failure: RuntimeFailure) => void | Promise<void>;
  } = {}
): Promise<T> {
  options.signal?.throwIfAborted();
  try {
    return await operation();
  } catch (error) {
    options.signal?.throwIfAborted();
    const failure = classifyRuntimeFailure(error);
    if (!failure.retryable) throw error;
    await options.beforeRetry?.(failure);
    options.signal?.throwIfAborted();
    return operation();
  }
}
import { isExpectedOperationCancellation } from '../shared/operationCancellation';
