import { describe, expect, it } from 'vitest';
import { getUpdateDownloadPhase, normalizeUpdateBytes } from '../../src/shared/updateProgress';

describe('update download progress', () => {
  it('keeps ordinary transfer progress in the incremental download phase', () => {
    expect(getUpdateDownloadPhase({ previousPercent: 43, percent: 44 })).toBe('downloading');
  });

  it('shows file verification only after the transfer has reached 100%', () => {
    expect(getUpdateDownloadPhase({ previousPercent: 99, percent: 100 })).toBe('verifying');
  });

  it('explains a differential download fallback as a full package download', () => {
    expect(getUpdateDownloadPhase({ previousPercent: 96, percent: 3 })).toBe('full-download');
    expect(getUpdateDownloadPhase({ previousPhase: 'full-download', previousPercent: 3, percent: 31 })).toBe(
      'full-download'
    );
  });

  it('drops invalid byte counters instead of showing misleading transfer data', () => {
    expect(normalizeUpdateBytes(-1)).toBeUndefined();
    expect(normalizeUpdateBytes(Number.NaN)).toBeUndefined();
    expect(normalizeUpdateBytes(1024.6)).toBe(1025);
  });
});
