import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const releaseDir = join(root, 'release');
const version = (await import('../package.json', { with: { type: 'json' } })).default.version;
const archive = join(tmpdir(), `youyu-release-${version}`);
const npmCli = process.env.npm_execpath;

if (!version) {
  throw new Error('Missing package version');
}

await rm(archive, { recursive: true, force: true });
await mkdir(archive, { recursive: true });

await run('npm', ['run', 'clean:release']);
await run('npm', ['run', 'assets']);

await run('npm', ['run', 'build:no-pet']);
await run('npm', ['run', 'cache:electron:win']);
await run('node', ['scripts/run-electron-builder.mjs', '--no-pet', '--public-update']);
await run('npm', ['run', 'validate:release:no:public']);
await keep([
  `YouYu-${version}-x64-no.exe`,
  `YouYu-${version}-x64-no.exe.blockmap`,
  'latest-no.yml'
]);

await run('npm', ['run', 'clean:release']);
await run('npm', ['run', 'build:in']);
await run('npm', ['run', 'cache:electron:win']);
await run('node', ['scripts/run-electron-builder.mjs', '--internal', '--public-update']);
await run('npm', ['run', 'validate:release:in:public']);
await keep([
  `YouYu-${version}-x64-in.exe`,
  `YouYu-${version}-x64-in.exe.blockmap`,
  'latest-in.yml'
]);

await run('npm', ['run', 'dist:win']);
await restore([
  `YouYu-${version}-x64-no.exe`,
  `YouYu-${version}-x64-no.exe.blockmap`,
  'latest-no.yml',
  `YouYu-${version}-x64-in.exe`,
  `YouYu-${version}-x64-in.exe.blockmap`,
  'latest-in.yml'
]);
await run('npm', ['run', 'smoke']);

const entries = (await readdir(releaseDir))
  .filter((name) => name.startsWith(`YouYu-${version}-x64`) || /^latest(?:-in|-no)?\.yml$/.test(name))
  .sort();
console.log(entries.join('\n'));

async function keep(names) {
  for (const name of names) {
    await copyFile(join(releaseDir, name), join(archive, name));
  }
}

async function restore(names) {
  for (const name of names) {
    await copyFile(join(archive, name), join(releaseDir, name));
  }
}

async function run(command, args) {
  const [resolvedCommand, resolvedArgs] = resolveCommand(command, args);
  await new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true
    });

    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${resolvedCommand} ${resolvedArgs.join(' ')} stopped by ${signal}`));
        return;
      }
      if (code) {
        reject(new Error(`${resolvedCommand} ${resolvedArgs.join(' ')} exited with ${code}`));
        return;
      }
      resolve();
    });

    child.once('error', reject);
  });
}

function resolveCommand(command, args) {
  if (command === 'node') {
    return [process.execPath, args];
  }
  if (command === 'npm') {
    if (!npmCli) {
      throw new Error('Missing npm_execpath; run this script through npm.');
    }
    return [process.execPath, [npmCli, ...args]];
  }
  return [command, args];
}
