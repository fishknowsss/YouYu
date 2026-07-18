import { describe, expect, it, vi } from 'vitest';
import { resolveAppVersion } from '../../src/main/appVersion';

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
