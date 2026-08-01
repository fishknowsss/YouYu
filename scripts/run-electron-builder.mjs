import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBuildEnvironment, resolveBuildMode } from './build-mode.mjs';
import {
  assertElectronDistributionManifest,
  getElectronArchivePath,
  validateElectronArchive
} from './electron-distribution.mjs';
import { assertWindowsSigningEnvironment, validateWindowsReleaseSignatures } from './windows-signing.mjs';
import packageJson from '../package.json' with { type: 'json' };

const builderCli = join(process.cwd(), 'node_modules', 'electron-builder', 'cli.js');
const mode = resolveBuildMode(process.argv.slice(2));
const { internalBuild, noPetBuild, publicUpdateBuild } = mode;
const bundledSubscriptionBuild = (internalBuild || noPetBuild) && !publicUpdateBuild;
const subscriptionSource = bundledSubscriptionBuild
  ? join(process.cwd(), 'resources', 'default-subscription.in.txt')
  : join(process.cwd(), 'resources', 'default-subscription.txt');
const generatedSubscription = join(process.cwd(), 'resources', 'generated', 'default-subscription.txt');
const releaseDir = join(process.cwd(), 'release');
const updateMetadataName = internalBuild ? 'latest-in.yml' : noPetBuild ? 'latest-no.yml' : 'latest.yml';
const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=DEP0190'].filter(Boolean).join(' ');
const signingPolicy = assertWindowsSigningEnvironment(process.env);
const electronVersion = packageJson.devDependencies.electron;
const electronArchivePath = getElectronArchivePath();

assertElectronDistributionManifest(electronVersion);
await validateElectronArchive(electronArchivePath);

await prepareSubscriptionResource();

const builderArgs = [
  builderCli,
  '--win',
  'nsis',
  '--x64',
  '--publish',
  'never',
  `-c.electronDist=${electronArchivePath}`
];
if (signingPolicy.required) {
  builderArgs.push('-c.forceCodeSigning=true', `-c.win.signtoolOptions.publisherName=${signingPolicy.publisherName}`);
}
if (internalBuild) {
  builderArgs.push('-c.win.artifactName=YouYu-${version}-${arch}-in.${ext}');
} else if (noPetBuild) {
  builderArgs.push('-c.win.artifactName=YouYu-${version}-${arch}-no.${ext}');
}

await runBuilder();
await prepareUpdateMetadata();
if (signingPolicy.required) {
  await validateWindowsReleaseSignatures({
    releaseDir,
    version: packageJson.version,
    channel: internalBuild ? 'in' : noPetBuild ? 'no' : 'standard',
    expectedPublisher: signingPolicy.publisherName
  });
}

async function runBuilder() {
  const buildEnvironment = {
    ...createBuildEnvironment(process.env, mode),
    NODE_OPTIONS: nodeOptions
  };
  if (!buildEnvironment.CSC_LINK && buildEnvironment.WIN_CSC_LINK) {
    buildEnvironment.CSC_LINK = buildEnvironment.WIN_CSC_LINK;
  }
  const child = spawn(process.execPath, builderArgs, {
    stdio: 'inherit',
    windowsHide: true,
    env: buildEnvironment
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
