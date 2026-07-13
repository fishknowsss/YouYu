import { describe, expect, it } from 'vitest';
import { calculateMainWindowMetrics } from '../../src/main/windowSizing';

describe('calculateMainWindowMetrics', () => {
  it.each([
    {
      name: '1920x1080 at 100%',
      displaySize: { width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1040 },
      expected: { width: 900, height: 600, zoomFactor: 1 }
    },
    {
      name: '1920x1080 at 125%',
      displaySize: { width: 1536, height: 864 },
      workAreaSize: { width: 1536, height: 824 },
      expected: { width: 720, height: 480, zoomFactor: 0.8 }
    },
    {
      name: '2560x1440 at 125%',
      displaySize: { width: 2048, height: 1152 },
      workAreaSize: { width: 2048, height: 1112 },
      expected: { width: 960, height: 640, zoomFactor: 16 / 15 }
    },
    {
      name: '3840x2160 at 150%',
      displaySize: { width: 2560, height: 1440 },
      workAreaSize: { width: 2560, height: 1400 },
      expected: { width: 1200, height: 800, zoomFactor: 4 / 3 }
    }
  ])('keeps the 900x600 baseline proportion on $name', ({ displaySize, workAreaSize, expected }) => {
    const result = calculateMainWindowMetrics(displaySize, workAreaSize);

    expect(result.width).toBe(expected.width);
    expect(result.height).toBe(expected.height);
    expect(result.zoomFactor).toBeCloseTo(expected.zoomFactor, 5);
    expect(result.width / result.height).toBeCloseTo(1.5, 5);
    expect(result.width).toBeLessThanOrEqual(workAreaSize.width);
    expect(result.height).toBeLessThanOrEqual(workAreaSize.height);
  });

  it('preserves the window aspect ratio on an ultrawide display', () => {
    const result = calculateMainWindowMetrics({ width: 3440, height: 1440 }, { width: 3440, height: 1400 });

    expect(result).toMatchObject({ width: 1200, height: 800 });
    expect(result.width / result.height).toBe(1.5);
  });

  it('shrinks to a constrained work area without clipping', () => {
    const result = calculateMainWindowMetrics({ width: 1920, height: 1080 }, { width: 1200, height: 500 });

    expect(result).toMatchObject({ width: 750, height: 500 });
    expect(result.zoomFactor).toBeCloseTo(5 / 6, 5);
  });
});
