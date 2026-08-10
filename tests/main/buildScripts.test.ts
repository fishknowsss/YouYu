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

  it('requires private installer subscriptions to match the local source exactly', async () => {
    const source = await readFile('scripts/validate-windows-release.ts', 'utf8');

    expect(source).toContain("join(root, 'resources', 'default-subscription.in.txt')");
    expect(source).toContain('bundledSubscriptionBytes.equals(privateSubscriptionBytes)');
  });

  it('always removes unique local and public release staging directories', async () => {
    for (const path of ['scripts/package-windows-local.mjs', 'scripts/package-windows-release.mjs']) {
      const source = await readFile(path, 'utf8');

      expect(source, path).toContain('mkdtemp(');
      expect(source, path).toContain('finally {');
      expect(source, path).toContain('await rm(archive, { recursive: true, force: true });');
    }
  });

  it('builds only the two private team installers in the local handoff workflow', async () => {
    const source = await readFile('scripts/package-windows-local.mjs', 'utf8');
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(source).toContain("await run('npm', ['run', 'dist:win:no']);");
    expect(source).toContain("await run('npm', ['run', 'dist:win:in']);");
    expect(source).not.toContain("await run('npm', ['run', 'dist:win']);");
    expect(source).toContain('await keep([`YouYu-${version}-x64-no.exe`]);');
    expect(source).toContain('await keep([`YouYu-${version}-x64-in.exe`]);');
    expect(source).not.toContain('x64-no.exe.blockmap');
    expect(source).not.toContain('x64-in.exe.blockmap');
    expect(source).toContain("await run('npm', ['run', 'smoke']);");
    expect(source).toContain("await run('node', ['scripts/validate-team-installers.mjs', archive]);");
    expect(source).toContain("await run('npm', ['run', 'clean:release']);");
    expect(source.indexOf('const teamBuilds = await refreshTeamBuilds')).toBeLessThan(
      source.lastIndexOf("['run', 'clean:release']")
    );

    expect(packageJson.scripts?.['dist:win:team']).toBe('node scripts/package-windows-local.mjs');
    expect(packageJson.scripts?.['dist:win:local']).toBe('npm run dist:win:team');
    expect(packageJson.scripts?.['validate:release:team']).toBe(
      'node scripts/validate-team-installers.mjs team-builds'
    );
  });

  it('reverse-extracts both private installers before the team handoff', async () => {
    const source = await readFile('scripts/validate-team-installers.mjs', 'utf8');

    expect(source).toContain('YouYu-${version}-x64-in.exe');
    expect(source).toContain('YouYu-${version}-x64-no.exe');
    expect(source).toContain('default-subscription.in.txt');
    expect(source).toContain('default-subscription\\.txt');
    expect(source).toContain('packagedSubscription.equals(expectedSubscription)');
    expect(source).toContain('Private team installer directory must contain exactly');
    expect(source).not.toContain('app-.*\\.7z');
    expect(source).toContain('await rm(auditDir, { recursive: true, force: true });');
  });

  it('keeps public release packaging isolated from the private team handoff', async () => {
    const source = await readFile('scripts/package-windows-release.mjs', 'utf8');

    expect(source).not.toContain('team-builds');
    expect(source).not.toContain('refreshTeamBuilds');
    expect(source).toContain("await run('node', ['scripts/archive-windows-release.mjs']);");
  });
});
