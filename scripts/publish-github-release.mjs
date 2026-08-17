import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'fishknowsss/YouYu';

export function assertPublicReleaseDirectory(directory) {
  const normalized = String(directory ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
  if (!normalized) throw new Error('release directory is required');
  if (normalized === 'team-builds' || normalized.endsWith('/team-builds')) {
    throw new Error('team-builds cannot be used as a public upload source');
  }
  return normalized;
}

export function buildReleaseUploadArgs(tag, files) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`invalid release tag: ${tag}`);
  if (!files.length) throw new Error('no public assets to upload');
  return ['release', 'upload', tag, '--clobber', ...files];
}

export function selectStarterAssetIds(assets, expectedNames) {
  const expected = new Set(expectedNames);
  return assets
    .filter((asset) => asset?.state === 'starter' && expected.has(asset.name) && Number.isInteger(asset.id))
    .map((asset) => asset.id);
}

export function getExpectedPublicAssetNames(version, sourceName) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid version: ${version}`);
  if (!sourceName?.startsWith(`YouYu-${version}-Mihomo-`) || !sourceName.endsWith('-source.tar.gz')) {
    throw new Error(`invalid Mihomo source archive name: ${sourceName}`);
  }
  return [
    `YouYu-${version}-x64.exe`,
    `YouYu-${version}-x64.exe.blockmap`,
    `YouYu-${version}-x64-in.exe`,
    `YouYu-${version}-x64-in.exe.blockmap`,
    `YouYu-${version}-x64-no.exe`,
    `YouYu-${version}-x64-no.exe.blockmap`,
    'latest.yml',
    'latest-in.yml',
    'latest-no.yml',
    sourceName,
    'SHA256SUMS.txt'
  ].sort();
}

export function resolveVersionFromTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) throw new Error(`invalid release tag: ${tag}`);
  return match[1];
}

function runGh(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('gh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...options
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(`gh ${args[0]} ${args[1] ?? ''} failed (${code})`));
    });
  });
}

async function listDirectoryAssets(directory, version) {
  let names = await readdir(directory);
  if (!names.includes('SHA256SUMS.txt') && names.includes('release')) {
    directory = join(directory, 'release');
    names = await readdir(directory);
  }
  const sourceName = names.find(
    (name) => name.startsWith(`YouYu-${version}-Mihomo-`) && name.endsWith('-source.tar.gz')
  );
  if (!sourceName) throw new Error(`missing Mihomo source archive in ${directory}`);
  const expected = getExpectedPublicAssetNames(version, sourceName);
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`missing public assets: ${missing.join(', ')}`);
  return expected.map((name) => join(directory, name));
}

async function ensureDraftRelease(tag, title, notes) {
  try {
    const raw = await runGh(['release', 'view', tag, '--json', 'id,isDraft']);
    const release = JSON.parse(raw);
    console.log(`using existing release ${tag} draft=${Boolean(release.isDraft)}`);
    return;
  } catch {
    await runGh(['release', 'create', tag, '--draft', '--verify-tag', '--title', title, '--notes', notes]);
    console.log(`created draft ${tag}`);
  }
}

async function deleteStarterAssets(tag, expectedNames) {
  const raw = await runGh(['release', 'view', tag, '--json', 'id,assets']);
  const release = JSON.parse(raw);
  const starterIds = selectStarterAssetIds(release.assets ?? [], expectedNames);
  for (const id of starterIds) {
    await runGh(['api', '-X', 'DELETE', `repos/${repository}/releases/assets/${id}`]);
    console.log(`deleted starter asset ${id}`);
  }
}

async function downloadRunArtifact(runId, version, directory) {
  await runGh(['run', 'download', String(runId), '--name', `youyu-windows-x64-${version}`, '--dir', directory]);
  console.log(`downloaded Build Windows artifact ${runId} into ${directory}`);
}

function parseArgs(argv) {
  const options = {
    tag: '',
    dir: '',
    fromRun: '',
    publish: false,
    title: '',
    notes: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--publish') options.publish = true;
    else if (arg === '--tag') options.tag = argv[++index] ?? '';
    else if (arg === '--dir') options.dir = argv[++index] ?? '';
    else if (arg === '--from-run') options.fromRun = argv[++index] ?? '';
    else if (arg === '--title') options.title = argv[++index] ?? '';
    else if (arg === '--notes') options.notes = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function publishGitHubRelease(options) {
  const tag = options.tag;
  const version = resolveVersionFromTag(tag);
  const directory = assertPublicReleaseDirectory(options.dir || 'release');
  if (options.fromRun) {
    await downloadRunArtifact(options.fromRun, version, directory);
  }
  const files = await listDirectoryAssets(directory, version);
  const expectedNames = files.map((file) => basename(file));
  await ensureDraftRelease(tag, options.title || `YouYu ${version}`, options.notes || `YouYu ${version}`);
  await deleteStarterAssets(tag, expectedNames);
  await runGh(buildReleaseUploadArgs(tag, files));
  console.log(`uploaded ${files.length} public assets to ${tag}`);
  if (options.publish) {
    await runGh(['release', 'edit', tag, '--draft=false']);
    console.log(`published ${tag}`);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  publishGitHubRelease(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
