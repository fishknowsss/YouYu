import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('test page shell alignment', () => {
  it('inherits the same workspace width, header track, and content gap as the other professional pages', async () => {
    const source = await readFile('src/renderer/styles.css', 'utf8');

    expect(source).not.toContain('.test-workspace {');
  });
});
