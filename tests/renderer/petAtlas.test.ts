import { describe, expect, it } from 'vitest';
import manifest from '../../src/renderer/assets/pet/youyu/spritesheet-manifest.json';
import { getPetAnimation, petStates } from '../../src/renderer/pet/atlas';

describe('pet atlas', () => {
  it('maps every desktop pet state to a real manifest row', () => {
    expect(petStates).toHaveLength(24);
    expect(petStates).not.toContain('edgePeek');

    for (const state of petStates) {
      const animation = getPetAnimation(state);

      expect(animation.frames).toBeGreaterThan(0);
      expect(animation.frames).toBeLessThanOrEqual(animation.atlasColumns);
      expect(animation.row).toBeGreaterThanOrEqual(0);
      expect(animation.row).toBeLessThan(animation.atlasRows);
      expect(animation.imageUrl).toContain('spritesheet');
      expect(animation.imageUrl).toContain('.webp');
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
    expect(getPetAnimation('edgeLeftBlink').row).toBe(getPetAnimation('edgeRightBlink').row);
    expect(getPetAnimation('edgeLeftBlink').frameIndexes).toEqual([0, 1, 2]);
    expect(getPetAnimation('edgeRightBlink').frameIndexes).toEqual([0, 1, 2]);
    expect(getPetAnimation('edgeLeftSleep').loop).toBe(true);
    expect(getPetAnimation('edgeRightSleep').loop).toBe(true);
    expect(getPetAnimation('edgeLeftSleep').row).toBe(getPetAnimation('edgeRightSleep').row);
    expect(getPetAnimation('edgeLeftSleep').frameIndexes).toEqual([0]);
    expect(getPetAnimation('edgeRightSleep').frameIndexes).toEqual([0]);
  });

  it('adds long-idle docked sleep states without new artwork rows', () => {
    const topSleep = getPetAnimation('topSleep');
    const bottomSleep = getPetAnimation('bottomSleep');
    const dizzy = getPetAnimation('bottomDizzy');
    const angry = getPetAnimation('bottomAngry');

    expect(topSleep.row).toBe(bottomSleep.row);
    expect(bottomSleep.row).toBe(getPetAnimation('sleepWake').row);
    expect(topSleep.loop).toBe(true);
    expect(bottomSleep.loop).toBe(true);
    expect(topSleep.frameIndexes).toEqual([3]);
    expect(bottomSleep.frameIndexes).toEqual([3]);
    expect(dizzy.row).toBe(getPetAnimation('fallRecover').row);
    expect(angry.row).toBe(getPetAnimation('annoyed').row);
    expect(dizzy.loop).toBe(false);
    expect(angry.loop).toBe(false);
    expect(dizzy.frameIndexes).toEqual([3, 4]);
    expect(angry.frameIndexes).toEqual([3, 4]);
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
    const idleRow = manifest.atlases.main.rows.idle;

    expect(idle.atlas).toBe('main');
    expect(idle.row).toBe(0);
    expect(idle.frameIndexes).toEqual([0, 1, 5, 1]);
    expect(idleRow.sourceKeys).not.toContain('a_no_mouth_r1c4');
    expect(idleRow.sourceKeys).not.toContain('a_no_mouth_r1c5');
    expect(idleRow.sourceKeys[3]).toBe('a_no_mouth_r1c1');
    expect(idleRow.sourceKeys[4]).toBe('a_no_mouth_r1c2');
  });

  it('keeps blink and sleep side-edge frames independent', () => {
    const blinkRow = manifest.atlases.extra.rows.edgeBlink;
    const sleepRow = manifest.atlases.extra.rows.edgeSleep;

    expect(blinkRow.sourceKeys).toEqual(['edgePeek_open', 'edgeBlink_closed_redraw_gpt_image_2', 'edgePeek_open']);
    expect(sleepRow.frames).toBe(1);
    expect(sleepRow.sourceKeys).toEqual(['edgeSide_sleep_reference']);
    expect(sleepRow.sourceKeys.join(' ')).not.toContain('redrawn');
    expect(getPetAnimation('edgeLeftBlink').row).toBe(blinkRow.row);
    expect(getPetAnimation('edgeRightBlink').row).toBe(blinkRow.row);
    expect(getPetAnimation('edgeLeftSleep').row).toBe(sleepRow.row);
    expect(getPetAnimation('edgeRightSleep').row).toBe(sleepRow.row);
  });

  it('uses the star-holding reward frames in ambient states', () => {
    const reward = getPetAnimation('rewardObserve');

    expect(reward.atlas).toBe('extra');
    expect(reward.frameIndexes).toEqual([2, 3, 4, 3]);
  });
});
