import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { reconcilePackagedMihomoAuthenticode } from './reconcile-packaged-mihomo.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const projectDir = context.packager.projectDir;
  await Promise.all([
    rm(join(context.appOutDir, 'resources', 'default_app.asar'), { force: true }),
    rm(join(context.appOutDir, 'version'), { force: true })
  ]);
  await reconcilePackagedMihomoAuthenticode({
    sourceDir: join(projectDir, 'resources', 'mihomo', 'win-x64'),
    packagedDir: join(context.appOutDir, 'resources', 'mihomo', 'win-x64'),
    signingRequired: process.env.YOUYU_REQUIRE_CODE_SIGNING === '1',
    expectedPublisher: process.env.YOUYU_WINDOWS_PUBLISHER_NAME
  });
}
