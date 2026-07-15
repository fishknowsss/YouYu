export function formatErrorWithCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const message = error.message;
  const code = findSafeErrorCode(error);
  return code && !message.toUpperCase().includes(code.toUpperCase()) ? `${message} (${code})` : message;
}

function findSafeErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/i.test(current.code)) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
