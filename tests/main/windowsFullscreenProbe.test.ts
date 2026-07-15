import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFullscreenProbeOutputConsumer,
  prepareWindowsFullscreenProbeExecutable,
  parseFullscreenProbeSample
} from '../../src/main/platform/windowsFullscreenProbe';

describe('Windows fullscreen probe', () => {
  it('parses only explicit fullscreen samples', () => {
    expect(parseFullscreenProbeSample('1')).toBe(true);
    expect(parseFullscreenProbeSample('0')).toBe(false);
    expect(parseFullscreenProbeSample('unexpected')).toBeUndefined();
  });

  it('ignores buffered probe samples after the process is stopped or failed', () => {
    const samples: boolean[] = [];
    let active = true;
    const consume = createFullscreenProbeOutputConsumer({
      isActive: () => active,
      onSample: (sample) => samples.push(sample)
    });

    consume('1\r\n');
    active = false;
    consume('0\r\n1\r\n');

    expect(samples).toEqual([true]);
  });

  it('keeps the native helper on the intended Z-order, DPI and maximized-window boundaries', async () => {
    const source = await readFile('native/windows-fullscreen-probe/Program.cs', 'utf8');

    expect(source).toContain('EnumWindows');
    expect(source).toContain('DWMWA_EXTENDED_FRAME_BOUNDS');
    expect(source).toContain('WS_EX_TOOLWINDOW');
    expect(source).toContain('WS_EX_TRANSPARENT');
    expect(source).toContain('SetThreadDpiAwarenessContext');
    expect(source).toContain('bool candidateFound = false');
    expect(source).toContain('candidateFound = true');
    expect(source).toContain('IsZoomed');
    expect(source).toContain('bool isSystemMaximized = IsZoomed(candidate) && (style & WS_CAPTION) != 0');
    expect(source).toContain('detected = !isSystemMaximized && MatchesMonitorBounds');
    expect(source).toContain('Progman');
    expect(source).toContain('WorkerW');
    expect(source).toContain('Shell_TrayWnd');
  });

  it('copies a content-addressed runtime helper and prunes an obsolete unlocked copy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youyu-fullscreen-helper-'));
    const sourcePath = join(directory, 'source.exe');
    const runtimeDirectory = join(directory, 'runtime');
    await writeFile(sourcePath, 'current helper');
    await writeFile(join(directory, 'unused'), 'unused');

    try {
      const first = await prepareWindowsFullscreenProbeExecutable({ sourcePath, runtimeDirectory });
      const obsolete = join(runtimeDirectory, 'windows-fullscreen-probe-0000000000000000.exe');
      await writeFile(obsolete, 'old helper');
      await writeFile(first, 'tampered helper');
      const second = await prepareWindowsFullscreenProbeExecutable({ sourcePath, runtimeDirectory });

      expect(second).toBe(first);
      expect(basename(first)).toMatch(/^windows-fullscreen-probe-[a-f0-9]{16}\.exe$/);
      expect(await readFile(first, 'utf8')).toBe('current helper');
      await expect(access(obsolete)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('compiles and executes the native helper without a pet HWND', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youyu-fullscreen-compile-'));
    const executablePath = join(directory, 'windows-fullscreen-probe.exe');
    const compilerPath = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
      'csc.exe'
    );

    try {
      const compile = spawnSync(
        compilerPath,
        [
          '/nologo',
          '/optimize+',
          '/target:exe',
          '/platform:x64',
          `/out:${executablePath}`,
          join(process.cwd(), 'native', 'windows-fullscreen-probe', 'Program.cs')
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
      );
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

      const run = spawnSync(executablePath, ['0', String(process.pid), '250', '1'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('0');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
