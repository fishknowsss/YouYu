import type { OperationRequest } from '../shared/ipc';

export function createOperationRequest(): OperationRequest {
  return { requestId: globalThis.crypto?.randomUUID?.() ?? createFallbackRequestId() };
}

function createFallbackRequestId(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
