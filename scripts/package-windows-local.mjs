import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshTeamBuilds } from './team-builds.mjs';

const root = process.cwd();
const releaseDir = join(root, 'release');
const version = (await import('../package.json', { with: { type: 'json' } })).default.version;
const npmCli = process.env.npm_execpath;

if (!version) {
  throw new Error('Missing package version');
}

const archive = await mkdtemp(join(tmpdir(), `youyu-local-${version}-`));

try {
  await run('npm', ['run', 'dist:win:no']);
  await keep([`YouYu-${version}-x64-no.exe`, `YouYu-${version}-x64-no.exe.blockmap`]);

  await run('npm', ['run', 'dist:win:in']);
  await keep([`YouYu-${version}-x64-in.exe`, `YouYu-${version}-x64-in.exe.blockmap`]);

  await run('npm', ['run', 'dist:win']);
  await restore([
    `YouYu-${version}-x64-no.exe`,
    `YouYu-${version}-x64-no.exe.blockmap`,
    `YouYu-${version}-x64-in.exe`,
    `YouYu-${version}-x64-in.exe.blockmap`
  ]);
  await run('npm', ['run', 'smoke']);

  const teamBuilds = await refreshTeamBuilds({ root, sourceDir: archive, version });

  const entries = (await readdir(releaseDir))
    .filter((name) => name.startsWith(`YouYu-${version}-x64`) || name === 'latest.yml')
    .sort();
  console.log(entries.join('\n'));
  console.log(`team-builds:\n${teamBuilds.map((path) => path.slice(root.length + 1)).join('\n')}`);
} finally {
  await rm(archive, { recursive: true, force: true });
}

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
  if (command === 'npm') {
    if (!npmCli) {
      throw new Error('Missing npm_execpath; run this script through npm.');
    }
    return [process.execPath, [npmCli, ...args]];
  }
  return [command, args];
}
