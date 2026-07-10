import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const builderCli = join(process.cwd(), 'node_modules', 'electron-builder', 'cli.js');
const internalBuild = process.argv.includes('--internal');
const noPetBuild = process.argv.includes('--no-pet');
const publicUpdateBuild = process.argv.includes('--public-update');
const bundledSubscriptionBuild = (internalBuild || noPetBuild) && !publicUpdateBuild;
const subscriptionSource = bundledSubscriptionBuild
  ? join(process.cwd(), 'resources', 'default-subscription.in.txt')
  : join(process.cwd(), 'resources', 'default-subscription.txt');
const generatedSubscription = join(process.cwd(), 'resources', 'generated', 'default-subscription.txt');
const releaseDir = join(process.cwd(), 'release');
const updateMetadataName = internalBuild ? 'latest-in.yml' : noPetBuild ? 'latest-no.yml' : 'latest.yml';
const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=DEP0190'].filter(Boolean).join(' ');

await prepareSubscriptionResource();

const builderArgs = [builderCli, '--win', 'nsis', '--x64', '--publish', 'never'];
if (internalBuild) {
  builderArgs.push('-c.win.artifactName=YouYu-${version}-${arch}-in.${ext}');
} else if (noPetBuild) {
  builderArgs.push('-c.win.artifactName=YouYu-${version}-${arch}-no.${ext}');
}

await runBuilder();
await prepareUpdateMetadata();

async function runBuilder() {
  const child = spawn(process.execPath, builderArgs, {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      YOUYU_DISABLE_PET: noPetBuild ? '1' : process.env.YOUYU_DISABLE_PET,
      NODE_OPTIONS: nodeOptions
    }
  });

  await new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`electron-builder stopped by ${signal}`));
        return;
      }
      if (code) {
        reject(new Error(`electron-builder exited with ${code}`));
        return;
      }
      resolve();
    });

    child.once('error', reject);
  });
}

async function prepareSubscriptionResource() {
  let subscription = '';
  try {
    subscription = await readFile(subscriptionSource, 'utf8');
  } catch (error) {
    if (bundledSubscriptionBuild) {
      throw new Error(
        `Missing bundled subscription file: ${subscriptionSource}. Create it locally; it is gitignored.`,
        { cause: error }
      );
    }
  }

  await mkdir(join(process.cwd(), 'resources', 'generated'), { recursive: true });
  await writeFile(generatedSubscription, subscription.trim() ? `${subscription.trim()}\n` : '', 'utf8');
}

async function prepareUpdateMetadata() {
  if (updateMetadataName === 'latest.yml') return;
  await rename(join(releaseDir, 'latest.yml'), join(releaseDir, updateMetadataName));
}
