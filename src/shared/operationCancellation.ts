const expectedCancellationPattern =
  /app runtime .* (?:superseded|stopped)|app runtime coordinator disposed|proxy start canceled|operation (?:cancel(?:ed|led)|replaced)|node testing cancel(?:ed|led)|node health background check superseded by manual result|refresh superseded by manual refresh|\baborterror\b/i;

/**
 * Identifies an intentional ownership hand-off or AbortSignal cancellation.
 * These outcomes must propagate to the caller, but must not be presented as a
 * runtime failure or trigger destructive repair retries.
 */
export function isExpectedOperationCancellation(error: unknown): boolean {
  return inspect(error, new Set<unknown>());
}

function inspect(value: unknown, visited: Set<unknown>): boolean {
  if (value === undefined || value === null || visited.has(value)) return false;
  if (typeof value === 'object') visited.add(value);

  if (value instanceof Error) {
    if (value.name === 'AbortError') return true;
    if (value instanceof AggregateError && value.errors.length > 0) {
      return value.errors.every((entry) => inspect(entry, visited));
    }
    if (
      expectedCancellationPattern.test(value.message) ||
      /^(?:this|the) operation was aborted$/i.test(value.message.trim())
    ) {
      return true;
    }
    return inspect(value.cause, visited);
  }

  return expectedCancellationPattern.test(String(value));
}
