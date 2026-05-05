import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const builderCli = join(process.cwd(), 'node_modules', 'electron-builder', 'cli.js');
const internalBuild = process.argv.includes('--internal');
const noPetBuild = process.argv.includes('--no-pet');
const bundledSubscriptionBuild = internalBuild || noPetBuild;
const subscriptionSource = bundledSubscriptionBuild
  ? join(process.cwd(), 'resources', 'default-subscription.in.txt')
  : join(process.cwd(), 'resources', 'default-subscription.txt');
const generatedSubscription = join(process.cwd(), 'resources', 'generated', 'default-subscription.txt');
const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=DEP0190']
  .filter(Boolean)
  .join(' ');

await prepareSubscriptionResource();

const builderArgs = [builderCli, '--win', 'nsis', '--x64', '--publish', 'never'];
if (internalBuild) {
  builderArgs.push('-c.win.artifactName=YouYu-${version}-${arch}-in.${ext}');
} else if (noPetBuild) {
  builderArgs.push('-c.win.artifactName=YouYu-${version}-${arch}-no.${ext}');
}

const child = spawn(
  process.execPath,
  builderArgs,
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      YOUYU_DISABLE_PET: noPetBuild ? '1' : process.env.YOUYU_DISABLE_PET,
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

async function prepareSubscriptionResource() {
  let subscription = '';
  try {
    subscription = await readFile(subscriptionSource, 'utf8');
  } catch (error) {
    if (bundledSubscriptionBuild) {
      throw new Error(
        `Missing bundled subscription file: ${subscriptionSource}. Create it locally; it is gitignored.`
      );
    }
  }

  await mkdir(join(process.cwd(), 'resources', 'generated'), { recursive: true });
  await writeFile(generatedSubscription, subscription.trim() ? `${subscription.trim()}\n` : '', 'utf8');
}
