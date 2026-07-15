import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('spinner animation styles', () => {
  it.each(['.busy-spinner', '.registration-spinner'])('%s renders the animated ring angle', async (selector) => {
    const styles = await readFile('src/renderer/styles.css', 'utf8');
    const start = styles.indexOf(`${selector} {`);
    const end = styles.indexOf('\n}', start);
    const rule = styles.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(rule).toContain('from var(--ring-angle)');
    expect(rule).toContain('animation: startup-ring-spin');
  });
});
