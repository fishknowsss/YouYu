import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('side-sleep Z animation', () => {
  it('lets the right-side Z animation mirror with the right-sleep sprite', async () => {
    const source = await readFile('src/renderer/styles.css', 'utf8');
    const rightSleepStart = source.indexOf('.pet-sprite-edgeRightSleep {');
    const rightSleepEnd = source.indexOf('\n}', rightSleepStart);
    const rightSleepRule = source.slice(rightSleepStart, rightSleepEnd + 2);

    expect(rightSleepRule).toContain('scaleX(-1)');
    expect(source).not.toContain('.pet-sprite-edgeRightSleep .pet-side-sleep-zs {');
  });
});
