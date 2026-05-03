import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const releaseDir = resolve(root, 'release');

if (!isDirectChild(root, releaseDir, 'release')) {
  throw new Error(`Refusing to clean unexpected release path: ${releaseDir}`);
}

await rm(releaseDir, { recursive: true, force: true });

console.log(`cleaned ${releaseDir}`);

function isDirectChild(parent, child, name) {
  return child === resolve(parent, name);
}
