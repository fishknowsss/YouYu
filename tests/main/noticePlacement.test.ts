import { describe, expect, it } from 'vitest';
import { resolvePetNoticePlacement } from '../../src/main/noticePlacement';

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const pet = { width: 190, height: 212 };
const notice = { width: 336, height: 188 };

describe('desktop companion notice placement', () => {
  it('puts every bottom-docked pet above the pet, including bottom-right corners', () => {
    const placement = resolvePetNoticePlacement({ ...pet, x: 1730, y: 828 }, workArea, notice);

    expect(placement.anchor).toBe('above');
    expect(placement.y + placement.height).toBeLessThanOrEqual(828 - 12);
  });

  it('expands inward from the left and right edges', () => {
    const left = resolvePetNoticePlacement({ ...pet, x: 0, y: 400 }, workArea, notice);
    const right = resolvePetNoticePlacement({ ...pet, x: 1730, y: 400 }, workArea, notice);

    expect(left.anchor).toBe('right');
    expect(left.x).toBe(202);
    expect(right.anchor).toBe('left');
    expect(right.x + right.width).toBe(1718);
  });

  it('places top-docked pets below and keeps free placement fully inside work area', () => {
    const top = resolvePetNoticePlacement({ ...pet, x: 600, y: 0 }, workArea, notice);
    const free = resolvePetNoticePlacement({ ...pet, x: 700, y: 500 }, workArea, notice);

    expect(top.anchor).toBe('below');
    expect(top.y).toBe(224);
    expect(free.anchor).toBe('above');
    expect(free.x).toBeGreaterThanOrEqual(12);
    expect(free.y).toBeGreaterThanOrEqual(12);
  });

  it('clamps independently on displays with negative coordinates and a narrow work area', () => {
    const negativeWorkArea = { x: -1280, y: 0, width: 1280, height: 760 };
    const placement = resolvePetNoticePlacement({ ...pet, x: -1270, y: 548 }, negativeWorkArea, notice);

    expect(placement.anchor).toBe('above');
    expect(placement.x).toBeGreaterThanOrEqual(-1268);
    expect(placement.x + placement.width).toBeLessThanOrEqual(-12);
    expect(placement.y).toBeGreaterThanOrEqual(12);
  });
});
