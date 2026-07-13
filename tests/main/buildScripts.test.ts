import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createBuildEnvironment, resolveBuildMode } from '../../scripts/build-mode.mjs';

describe('Windows build scripts', () => {
  it('forces pet assets on for standard and internal builds even when the parent environment disables them', () => {
    const inheritedEnvironment = { YOUYU_DISABLE_PET: '1', KEEP_ME: 'yes' };

    expect(createBuildEnvironment(inheritedEnvironment, resolveBuildMode([]))).toMatchObject({
      KEEP_ME: 'yes',
      YOUYU_BUILD_CHANNEL: 'standard',
      YOUYU_DISABLE_PET: '0'
    });
    expect(createBuildEnvironment(inheritedEnvironment, resolveBuildMode(['--internal']))).toMatchObject({
      KEEP_ME: 'yes',
      YOUYU_BUILD_CHANNEL: 'in',
      YOUYU_DISABLE_PET: '0'
    });
    expect(createBuildEnvironment(inheritedEnvironment, resolveBuildMode(['--no-pet']))).toMatchObject({
      KEEP_ME: 'yes',
      YOUYU_BUILD_CHANNEL: 'no',
      YOUYU_DISABLE_PET: '1'
    });
  });

  it('rejects an artifact that is both internal and no-pet', () => {
    expect(() => resolveBuildMode(['--internal', '--no-pet'])).toThrow('Cannot combine --internal and --no-pet.');
  });

  it('rejects misspelled or unsupported build arguments', () => {
    expect(() => resolveBuildMode(['--public-updte'])).toThrow('Unknown build argument: --public-updte');
  });

  it('uses the shared build-mode guard in every artifact script', async () => {
    for (const path of [
      'scripts/run-build.mjs',
      'scripts/run-electron-builder.mjs',
      'scripts/validate-windows-release.ts'
    ]) {
      const source = await readFile(path, 'utf8');
      expect(source, path).toContain('resolveBuildMode(process.argv.slice(2))');
    }
  });

  it('always removes unique local and public release staging directories', async () => {
    for (const path of ['scripts/package-windows-local.mjs', 'scripts/package-windows-release.mjs']) {
      const source = await readFile(path, 'utf8');

      expect(source, path).toContain('mkdtemp(');
      expect(source, path).toContain('finally {');
      expect(source, path).toContain('await rm(archive, { recursive: true, force: true });');
    }
  });
});
