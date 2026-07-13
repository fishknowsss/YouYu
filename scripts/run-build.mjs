import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createBuildEnvironment, resolveBuildMode } from './build-mode.mjs';

const mode = resolveBuildMode(process.argv.slice(2));
const tscCli = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
const electronViteCli = join(process.cwd(), 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');

await Promise.all([
  rm(join(process.cwd(), 'out', 'main'), { recursive: true, force: true }),
  rm(join(process.cwd(), 'out', 'preload'), { recursive: true, force: true }),
  rm(join(process.cwd(), 'out', 'renderer'), { recursive: true, force: true })
]);
await run(process.execPath, [tscCli, '--noEmit']);
await run(process.execPath, [electronViteCli, 'build'], createBuildEnvironment(process.env, mode));

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
      env
    });

    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} stopped by ${signal}`));
        return;
      }
      if (code) {
        reject(new Error(`${command} exited with ${code}`));
        return;
      }
      resolve();
    });

    child.once('error', reject);
  });
}
