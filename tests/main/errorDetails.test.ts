import { describe, expect, it } from 'vitest';
import { formatErrorWithCause } from '../../src/main/errorDetails';
import { classifyDiagnosticIssue } from '../../src/main/diagnostics';

describe('error details', () => {
  it('surfaces a nested DNS code without exposing nested request data', () => {
    const error = new Error('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND secret.example/path?token=hidden'), {
        code: 'ENOTFOUND'
      })
    });

    const formatted = formatErrorWithCause(error);

    expect(formatted).toBe('fetch failed (ENOTFOUND)');
    expect(formatted).not.toContain('secret.example');
    expect(classifyDiagnosticIssue(formatted)).toBe('dns');
  });

  it('does not duplicate a code already present in the public message', () => {
    const error = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    expect(formatErrorWithCause(error)).toBe('connect ECONNRESET');
  });

  it('keeps non-Error values readable', () => {
    expect(formatErrorWithCause('network unavailable')).toBe('network unavailable');
  });
});
