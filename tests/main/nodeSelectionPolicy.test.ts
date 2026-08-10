import { describe, expect, it } from 'vitest';
import {
  detectNodeRegion,
  exitRegionLabel,
  isNodeInPreferredRegion,
  resolveNodeSelectionPolicy
} from '../../src/main/mihomo/nodeSelectionPolicy';

describe('node selection policy', () => {
  it('defaults existing clients to Japan priority with healthy global fallback', () => {
    expect(resolveNodeSelectionPolicy()).toEqual({ preferredRegion: 'jp', regionFallback: 'global' });
  });

  it('recognizes common simplified, traditional, English, and flag region names', () => {
    expect(isNodeInPreferredRegion('🇯🇵 日本 08 家宽', 'jp')).toBe(true);
    expect(isNodeInPreferredRegion('Tokyo Premium 01', 'jp')).toBe(true);
    expect(isNodeInPreferredRegion('香港 HKT 02', 'hk')).toBe(true);
    expect(isNodeInPreferredRegion('台灣 09 家寬', 'tw')).toBe(true);
    expect(detectNodeRegion('Singapore IPLC 01')).toBe('sg');
  });

  it('forces lowest-latency mode to global selection and labels unknown exits safely', () => {
    expect(resolveNodeSelectionPolicy({ preferredRegion: 'auto', regionFallback: 'strict' } as never)).toEqual({
      preferredRegion: 'auto',
      regionFallback: 'global'
    });
    expect(exitRegionLabel('HK')).toBe('香港');
    expect(exitRegionLabel('GB')).toBe('其他地区');
  });
});
