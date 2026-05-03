import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const releaseDir = join(root, 'release');

const packageJson = (await import('../package.json', { with: { type: 'json' } })).default as {
  version?: string;
};

if (!packageJson.version) {
  throw new Error('Missing package version');
}

const expectedInstallerName = `YouYu-${packageJson.version}-x64.exe`;
const expectedInstallerPath = join(releaseDir, expectedInstallerName);

await access(expectedInstallerPath);

const entries = await readdir(releaseDir, { withFileTypes: true });
const exeEntries = entries
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
  .map((entry) => entry.name);

if (exeEntries.length !== 1 || exeEntries[0] !== expectedInstallerName) {
  throw new Error(
    `Expected exactly one installer exe (${expectedInstallerName}), found: ${exeEntries.join(', ') || '<none>'}`
  );
}

const confusingEntries = entries
  .filter((entry) => /arm64|ia32/i.test(entry.name))
  .map((entry) => entry.name);

if (confusingEntries.length > 0) {
  throw new Error(`Unexpected non-x64 Windows release entries: ${confusingEntries.join(', ')}`);
}

const currentInstaller = await stat(expectedInstallerPath);
if (currentInstaller.size < 80 * 1024 * 1024) {
  throw new Error(`Installer is unexpectedly small: ${expectedInstallerName}`);
}

console.log(`validated Windows x64 installer: ${expectedInstallerName}`);
