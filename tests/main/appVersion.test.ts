import { describe, expect, it, vi } from 'vitest';
import { formatReportedAppVersion, resolveAppVersion } from '../../src/main/appVersion';

describe('resolveAppVersion', () => {
  it('uses Electron application metadata for a packaged build', () => {
    const readFile = vi.fn();

    expect(
      resolveAppVersion({
        isPackaged: true,
        packagedVersion: '1.6.5',
        developmentPackagePath: 'missing-package.json',
        readFile
      })
    ).toBe('1.6.5');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reads the project package version during development', () => {
    expect(
      resolveAppVersion({
        isPackaged: false,
        packagedVersion: '0.0.0',
        developmentPackagePath: 'package.json',
        readFile: () => JSON.stringify({ version: '1.6.5' })
      })
    ).toBe('1.6.5');
  });

  it('uses a safe fallback for unavailable version metadata', () => {
    expect(
      resolveAppVersion({
        isPackaged: false,
        packagedVersion: '',
        developmentPackagePath: 'package.json',
        readFile: () => {
          throw new Error('unavailable');
        }
      })
    ).toBe('0.0.0');
  });
});

describe('formatReportedAppVersion', () => {
  it('keeps the public version stable and labels private build channels for the admin inventory', () => {
    expect(formatReportedAppVersion('1.7.1', 'standard')).toBe('1.7.1');
    expect(formatReportedAppVersion('1.7.1', 'in')).toBe('1.7.1-IN');
    expect(formatReportedAppVersion('1.7.1', 'no')).toBe('1.7.1-NO');
  });
});
