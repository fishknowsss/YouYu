import { build } from 'vite';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
await build({
  configFile: false,
  build: {
    ssr: 'tests/electron/windowStartup.ts',
    outDir: 'output/window-startup',
    target: 'node24',
    rollupOptions: { external: ['electron'], output: { entryFileNames: 'check.mjs' } }
  }
});
const profile = await mkdtemp(resolve(tmpdir(), 'youyu-window-startup-'));
try {
  process.exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(
      require('electron'),
      [resolve('output/window-startup/check.mjs'), `--user-data-dir=${profile}`],
      {
        stdio: 'inherit',
        timeout: 30_000
      }
    );
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
