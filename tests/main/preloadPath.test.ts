import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('packaged preload path', () => {
  it('loads the electron-vite preload output file', async () => {
    const source = await readFile('src/main/index.ts', 'utf8');
    const config = await readFile('electron.vite.config.ts', 'utf8');

    expect(config).toContain("format: 'cjs'");
    expect(config).toContain("entryFileNames: '[name].cjs'");
    expect(source).toContain("../preload/index.cjs");
    expect(source).not.toContain("../preload/index.mjs");
    expect(source).toContain('sandbox: false');
  });
});
