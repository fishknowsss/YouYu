import { describe, expect, it } from 'vitest';
import { getPetAnimation, petStates } from '../../src/renderer/pet/atlas';

describe('pet atlas', () => {
  it('maps every desktop pet state to a real manifest row', () => {
    expect(petStates).toHaveLength(17);

    for (const state of petStates) {
      const animation = getPetAnimation(state);

      expect(animation.frames).toBeGreaterThan(0);
      expect(animation.frames).toBeLessThanOrEqual(animation.atlasColumns);
      expect(animation.row).toBeGreaterThanOrEqual(0);
      expect(animation.row).toBeLessThan(animation.atlasRows);
      expect(animation.imageUrl).toContain('spritesheet');
    }
  });

  it('uses the walking rows for left and right movement', () => {
    const right = getPetAnimation('walkRight');
    const left = getPetAnimation('walkLeft');

    expect(right.atlas).toBe('main');
    expect(left.atlas).toBe('main');
    expect(right.row).not.toBe(left.row);
    expect(right.frameIndexes).toHaveLength(6);
    expect(left.frameIndexes).toHaveLength(6);
  });

  it('keeps stable states only for the side screen edges', () => {
    expect(petStates).not.toContain('edgeTop');
    expect(petStates).not.toContain('edgeBottom');
    expect(getPetAnimation('edgeLeft').loop).toBe(true);
    expect(getPetAnimation('edgeRight').loop).toBe(true);
    expect(getPetAnimation('edgeLeft').frameIndexes).toEqual([0]);
    expect(getPetAnimation('edgeRight').frameIndexes).toEqual([0]);
  });

  it('keeps lift hold as a stable single frame', () => {
    const liftHold = getPetAnimation('liftHold');
    const drag = getPetAnimation('drag');

    expect(liftHold.loop).toBe(true);
    expect(liftHold.frameIndexes).toEqual([1]);
    expect(liftHold.atlas).toBe('main');
    expect(liftHold.row).toBe(drag.row);
  });

  it('uses multiple front-facing open-eye idle frames for normal ambient states', () => {
    const idle = getPetAnimation('idle');

    expect(idle.atlas).toBe('main');
    expect(idle.row).toBe(0);
    expect(idle.frameIndexes).toEqual([0, 1, 5, 1]);
  });

  it('uses the star-holding reward frames in ambient states', () => {
    const reward = getPetAnimation('rewardObserve');

    expect(reward.atlas).toBe('extra');
    expect(reward.frameIndexes).toEqual([2, 3, 4, 3]);
  });
});
