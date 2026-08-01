import { readFile } from 'node:fs/promises';

export const rendererStyleEntryPath = 'src/renderer/styles.css';

export const rendererStyleSourcePaths = [
  'src/renderer/styles/tokens.css',
  'src/renderer/styles/shell.css',
  'src/renderer/styles/home.css',
  'src/renderer/styles/pet.css',
  'src/renderer/styles/dashboard.css',
  'src/renderer/styles/settings.css',
  'src/renderer/styles/test.css',
  'src/renderer/styles/responsive.css'
] as const;

export async function readRendererStyles(): Promise<string> {
  const sources = await Promise.all(rendererStyleSourcePaths.map((path) => readFile(path, 'utf8')));
  return sources.join('');
}
