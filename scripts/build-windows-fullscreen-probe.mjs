import { spawn } from 'node:child_process';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const sourcePath = join(root, 'native', 'windows-fullscreen-probe', 'Program.cs');
const outputDirectory = join(root, 'resources', 'generated');
const outputPath = join(outputDirectory, 'windows-fullscreen-probe.exe');

export async function buildWindowsFullscreenProbe() {
  if (process.platform !== 'win32') return undefined;

  const cscPath = await resolveCompilerPath();
  const temporaryPath = join(outputDirectory, `.windows-fullscreen-probe-${process.pid}.exe`);
  await mkdir(outputDirectory, { recursive: true });
  await rm(temporaryPath, { force: true });
  try {
    await run(cscPath, [
      '/nologo',
      '/optimize+',
      '/debug-',
      '/target:exe',
      '/platform:x64',
      `/out:${temporaryPath}`,
      sourcePath
    ]);
    await rm(outputPath, { force: true });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return outputPath;
}

async function resolveCompilerPath() {
  const windowsDirectory = process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = [
    join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next Windows .NET Framework compiler location.
    }
  }
  throw new Error('Windows .NET Framework C# compiler was not found; cannot build fullscreen probe');
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
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
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildWindowsFullscreenProbe();
}
