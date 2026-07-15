import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('side-sleep Z animation', () => {
  it('mirrors the right-sleep trajectory while keeping every Z glyph readable', async () => {
    const [styles, component] = await Promise.all([
      readFile('src/renderer/styles.css', 'utf8'),
      readFile('src/renderer/components/PetSprite.tsx', 'utf8')
    ]);
    const rightSleepStart = styles.indexOf('.pet-sprite-edgeRightSleep {');
    const rightSleepEnd = styles.indexOf('\n}', rightSleepStart);
    const rightSleepRule = styles.slice(rightSleepStart, rightSleepEnd + 2);

    expect(rightSleepRule).toContain('scaleX(-1)');
    expect(component.match(/className="pet-side-sleep-z-glyph"/g)).toHaveLength(3);
    expect(styles).toMatch(/\.pet-sprite-edgeRightSleep \.pet-side-sleep-z-glyph\s*\{[^}]*transform:\s*scaleX\(-1\)/s);
    expect(styles).not.toContain('.pet-sprite-edgeRightSleep .pet-side-sleep-zs {');
  });
});
