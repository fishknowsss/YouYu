import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRendererStyles, rendererStyleEntryPath, rendererStyleSourcePaths } from './helpers/rendererStyles';

function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

describe('renderer style source contract', () => {
  it('keeps the entrypoint import-only and preserves the canonical cascade order', async () => {
    const entrySource = await readFile(rendererStyleEntryPath, 'utf8');
    const imports = [...entrySource.matchAll(/^@import\s+(['"])([^'"]+)\1;\s*$/gm)].map((match) => match[2]);
    const expectedImports = rendererStyleSourcePaths.map(
      (path) => `./${toPosixPath(relative(dirname(rendererStyleEntryPath), path))}`
    );

    expect(imports).toEqual(expectedImports);
    expect(new Set(imports).size).toBe(imports.length);
    expect(entrySource.replace(/^@import\s+(['"])([^'"]+)\1;\s*$/gm, '').trim()).toBe('');
  });

  it('covers every renderer stylesheet exactly once', async () => {
    const stylesDirectory = dirname(rendererStyleSourcePaths[0]);
    const actualSources = (await readdir(stylesDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
      .map((entry) => toPosixPath(`${stylesDirectory}/${entry.name}`))
      .sort();

    expect([...rendererStyleSourcePaths].sort()).toEqual(actualSources);
  });

  it('concatenates all style sources in the same fixed order used by static renderer tests', async () => {
    const expected = (await Promise.all(rendererStyleSourcePaths.map((path) => readFile(path, 'utf8')))).join('');

    expect(await readRendererStyles()).toBe(expected);
  });

  it('keeps main.tsx importing only the renderer style entrypoint', async () => {
    const mainSource = await readFile('src/renderer/main.tsx', 'utf8');

    expect(mainSource).toContain("import './styles.css';");
    expect(mainSource).not.toMatch(/import ['"]\.\/styles\//);
  });
});
