import { spawn } from 'node:child_process';
import { join } from 'node:path';

const builderCli = join(process.cwd(), 'node_modules', 'electron-builder', 'cli.js');
const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=DEP0190']
  .filter(Boolean)
  .join(' ');

const child = spawn(
  process.execPath,
  [builderCli, '--win', 'nsis', '--x64', '--publish', 'never'],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions
    }
  }
);

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`electron-builder stopped by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.once('error', (error) => {
  console.error(error);
  process.exit(1);
});
