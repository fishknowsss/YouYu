import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const assetScript = join(scriptDir, 'generate-brand-assets.py');
const candidates =
  process.platform === 'win32'
    ? [
        ['python3', [assetScript]],
        ['python', [assetScript]],
        ['py', ['-3', assetScript]]
      ]
    : [
        ['python3', [assetScript]],
        ['python', [assetScript]]
      ];

const failures = [];

for (const [command, args] of candidates) {
  const result = await run(command, args);
  if (result.code === 0) {
    process.exit(0);
  }
  failures.push(`${command}: ${result.error ?? `exit ${result.code}`}`);
}

throw new Error(`Unable to generate brand assets with Python. Tried ${failures.join(', ')}`);

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true
    });

    child.once('error', (error) => {
      resolve({ code: null, error: error.message });
    });
    child.once('exit', (code) => {
      resolve({ code });
    });
  });
}
