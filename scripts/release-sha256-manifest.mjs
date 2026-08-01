import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const releaseSha256ManifestName = 'SHA256SUMS.txt';

export async function createReleaseSha256Manifest({ releaseDir, version }) {
  assertVersion(version);
  const assetNames = await listExpectedPublicAssets(releaseDir, version);
  const lines = [];
  for (const name of assetNames) lines.push(`${await hashFileSha256(join(releaseDir, name))}  ${name}`);

  const manifestPath = join(releaseDir, releaseSha256ManifestName);
  const temporaryPath = join(releaseDir, `.${releaseSha256ManifestName}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, manifestPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return { manifestPath, assetCount: assetNames.length };
}

export async function verifyReleaseSha256Manifest({ releaseDir, version }) {
  assertVersion(version);
  const manifestPath = join(releaseDir, releaseSha256ManifestName);
  const source = await readFile(manifestPath, 'utf8');
  const lines = source.trimEnd().split('\n');
  const expectedNames = await listExpectedPublicAssets(releaseDir, version);
  const entries = lines.map((line, index) => {
    const match = line.match(/^([a-f0-9]{64}) {2}([^/\\]+)$/);
    if (!match) throw new Error(`Invalid SHA256 manifest line ${index + 1}`);
    return { sha256: match[1], name: match[2] };
  });
  const listedNames = entries.map((entry) => entry.name);
  if (new Set(listedNames).size !== listedNames.length) throw new Error('SHA256 manifest contains duplicate assets');
  if (JSON.stringify(listedNames) !== JSON.stringify(expectedNames)) {
    throw new Error('SHA256 manifest asset list does not match the public release assets');
  }

  for (const entry of entries) {
    const actual = await hashFileSha256(join(releaseDir, entry.name));
    if (actual !== entry.sha256) throw new Error(`SHA256 mismatch for ${entry.name}`);
  }
  return { manifestPath, assetCount: entries.length };
}

async function listExpectedPublicAssets(releaseDir, version) {
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const expectedFixed = [
    `YouYu-${version}-x64.exe`,
    `YouYu-${version}-x64.exe.blockmap`,
    `YouYu-${version}-x64-in.exe`,
    `YouYu-${version}-x64-in.exe.blockmap`,
    `YouYu-${version}-x64-no.exe`,
    `YouYu-${version}-x64-no.exe.blockmap`,
    'latest.yml',
    'latest-in.yml',
    'latest-no.yml'
  ];
  const missing = expectedFixed.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`Public release is missing SHA256 assets: ${missing.join(', ')}`);

  const sourcePattern = new RegExp(`^YouYu-${escapeRegExp(version)}-Mihomo-v[0-9A-Za-z.-]+-source\\.tar\\.gz$`);
  const sourceNames = names.filter((name) => sourcePattern.test(name));
  if (sourceNames.length !== 1) {
    throw new Error(`Expected exactly one Mihomo source archive, found ${sourceNames.length}`);
  }
  return [...expectedFixed, sourceNames[0]].sort();
}

async function hashFileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function assertVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version for SHA256 manifest: ${String(version)}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function run() {
  const root = process.cwd();
  const releaseDir = join(root, 'release');
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const options = { releaseDir, version: packageJson.version };
  const result = process.argv.includes('--verify')
    ? await verifyReleaseSha256Manifest(options)
    : await createReleaseSha256Manifest(options);
  console.log(`${basename(result.manifestPath)}: ${result.assetCount} assets`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
