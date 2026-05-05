import { spawn } from 'node:child_process';
import { join } from 'node:path';

const noPetBuild = process.argv.includes('--no-pet');
const internalBuild = process.argv.includes('--internal');
const tscCli = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
const electronViteCli = join(process.cwd(), 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
const buildChannel = noPetBuild ? 'no' : internalBuild ? 'in' : 'standard';

await run(process.execPath, [tscCli, '--noEmit']);
await run(process.execPath, [electronViteCli, 'build'], {
  YOUYU_BUILD_CHANNEL: buildChannel,
  YOUYU_DISABLE_PET: noPetBuild ? '1' : process.env.YOUYU_DISABLE_PET
});

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ...env
      }
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
