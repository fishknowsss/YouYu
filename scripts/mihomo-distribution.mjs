import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const mihomoResourceRelativePath = 'resources/mihomo/win-x64';
export const mihomoManifestFileName = 'manifest.json';

export async function readMihomoManifest(distributionDir) {
  const manifestPath = join(distributionDir, mihomoManifestFileName);
  let source;
  try {
    source = await readFile(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`Mihomo manifest missing or unreadable: ${manifestPath}`, { cause: error });
  }

  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`Mihomo manifest is not valid JSON: ${manifestPath}`, { cause: error });
  }

  validateManifestShape(manifest, manifestPath);
  return manifest;
}

export async function validateMihomoDistribution(distributionDir, options = {}) {
  const absoluteDirectory = resolve(distributionDir);
  const manifest = await readMihomoManifest(absoluteDirectory);
  const binaryPath = resolveDistributionFile(absoluteDirectory, manifest.binary.file, 'binary');
  const licensePath = resolveDistributionFile(absoluteDirectory, manifest.license.file, 'license');
  const sourceNoticePath = resolveDistributionFile(
    absoluteDirectory,
    manifest.license.sourceNoticeFile,
    'source notice'
  );

  const binary = await statRequired(binaryPath, 'Mihomo binary');
  if (binary.size !== manifest.binary.size) {
    throw new Error(`Mihomo binary size mismatch: expected ${manifest.binary.size}, got ${binary.size}`);
  }

  const binarySha256 = await hashFileSha256(binaryPath);
  if (binarySha256 !== manifest.binary.sha256) {
    throw new Error(`Mihomo binary SHA256 mismatch: expected ${manifest.binary.sha256}, got ${binarySha256}`);
  }

  const license = await readRequiredText(licensePath, 'Mihomo GPL license');
  if (
    license.length < 30_000 ||
    !license.includes('GNU GENERAL PUBLIC LICENSE') ||
    !license.includes('Version 3, 29 June 2007') ||
    !license.includes('END OF TERMS AND CONDITIONS')
  ) {
    throw new Error(`Mihomo GPL license is incomplete or unexpected: ${licensePath}`);
  }

  const sourceNotice = await readRequiredText(sourceNoticePath, 'Mihomo source notice');
  for (const value of [
    manifest.project,
    manifest.tag,
    manifest.tagCommit,
    manifest.upstreamAsset.name,
    manifest.upstreamAsset.url,
    manifest.upstreamAsset.sha256,
    manifest.binary.sha256,
    manifest.sourceArchive.upstreamUrl,
    manifest.sourceArchive.sha256,
    manifest.license.file
  ]) {
    if (!sourceNotice.includes(value)) {
      throw new Error(`Mihomo source notice is missing manifest value: ${value}`);
    }
  }

  const readVersionOutput = options.readVersionOutput ?? runMihomoVersion;
  const actualVersionOutput = normalizeVersionOutput(await readVersionOutput(binaryPath));
  const expectedVersionOutput = normalizeVersionOutput(manifest.binary.versionOutput);
  if (actualVersionOutput !== expectedVersionOutput) {
    throw new Error(
      `Mihomo version output mismatch: expected ${JSON.stringify(expectedVersionOutput)}, got ${JSON.stringify(actualVersionOutput)}`
    );
  }

  return {
    manifest,
    binaryPath,
    licensePath,
    sourceNoticePath,
    binarySha256,
    versionOutput: actualVersionOutput
  };
}

export function assertPackagedMihomoMatchesSource(sourceManifest, packagedManifest) {
  if (isDeepStrictEqual(packagedManifest, sourceManifest)) return { signed: false };

  const packagedBinary = packagedManifest?.binary;
  if (
    !isRecord(packagedBinary) ||
    packagedBinary.unsignedSize !== sourceManifest.binary.size ||
    packagedBinary.unsignedSha256 !== sourceManifest.binary.sha256 ||
    typeof packagedBinary.authenticodeSubject !== 'string' ||
    !packagedBinary.authenticodeSubject.trim() ||
    typeof packagedBinary.authenticodeThumbprint !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(packagedBinary.authenticodeThumbprint)
  ) {
    throw new Error('Packaged Mihomo manifest has an invalid Authenticode provenance envelope');
  }

  const normalized = structuredClone(packagedManifest);
  normalized.binary.size = normalized.binary.unsignedSize;
  normalized.binary.sha256 = normalized.binary.unsignedSha256;
  delete normalized.binary.unsignedSize;
  delete normalized.binary.unsignedSha256;
  delete normalized.binary.authenticodeSubject;
  delete normalized.binary.authenticodeThumbprint;
  if (!isDeepStrictEqual(normalized, sourceManifest)) {
    throw new Error('Packaged Mihomo manifest differs outside the Authenticode provenance envelope');
  }

  return {
    signed: true,
    signerSubject: packagedBinary.authenticodeSubject,
    signerThumbprint: packagedBinary.authenticodeThumbprint.toUpperCase()
  };
}

export function resolveMihomoSourceReleaseAssetName(manifest, appVersion) {
  if (typeof appVersion !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(appVersion)) {
    throw new Error(`Invalid YouYu version for Mihomo source asset: ${String(appVersion)}`);
  }

  const template = manifest.sourceArchive.releaseAssetNameTemplate;
  if (!template.includes('${appVersion}')) {
    throw new Error('Mihomo source archive name template is missing ${appVersion}');
  }

  const name = template.replaceAll('${appVersion}', appVersion);
  assertDistributionFileName(name, 'source archive release asset');
  if (!name.endsWith('.tar.gz')) {
    throw new Error(`Mihomo source archive must use .tar.gz: ${name}`);
  }
  return name;
}

export async function validateMihomoSourceArchive(archivePath, manifest) {
  const archive = await statRequired(archivePath, 'Mihomo source archive');
  if (archive.size !== manifest.sourceArchive.size) {
    throw new Error(
      `Mihomo source archive size mismatch: expected ${manifest.sourceArchive.size}, got ${archive.size}`
    );
  }

  const sha256 = await hashFileSha256(archivePath);
  if (sha256 !== manifest.sourceArchive.sha256) {
    throw new Error(`Mihomo source archive SHA256 mismatch: expected ${manifest.sourceArchive.sha256}, got ${sha256}`);
  }

  const listing = spawnSync(resolveTarExecutable(), ['-tzf', archivePath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (listing.error || listing.status !== 0) {
    throw new Error(
      `Unable to inspect Mihomo source archive: ${listing.error?.message ?? (listing.stderr.trim() || `exit ${listing.status}`)}`
    );
  }

  const root = `mihomo-${manifest.tagCommit}/`;
  const entries = new Set(listing.stdout.replaceAll('\\', '/').split(/\r?\n/).filter(Boolean));
  for (const requiredEntry of ['LICENSE', 'Makefile', 'go.mod', 'go.sum', 'main.go']) {
    if (!entries.has(`${root}${requiredEntry}`)) {
      throw new Error(`Mihomo source archive is missing ${requiredEntry} for ${manifest.tagCommit}`);
    }
  }

  return { sha256, size: archive.size };
}

export async function hashFileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function validateManifestShape(manifest, manifestPath) {
  if (!isRecord(manifest)) throw new Error(`Mihomo manifest must be an object: ${manifestPath}`);
  assertEqual(manifest.schemaVersion, 1, 'schemaVersion');
  assertNonEmptyString(manifest.project, 'project');
  assertHttpsUrl(manifest.repositoryUrl, 'repositoryUrl');
  assertVersion(manifest.version);
  assertEqual(manifest.tag, `v${manifest.version}`, 'tag');
  assertHex(manifest.tagCommit, 40, 'tagCommit');
  assertEqual(manifest.platform, 'windows', 'platform');
  assertEqual(manifest.architecture, 'amd64', 'architecture');
  if (!Array.isArray(manifest.buildTags) || manifest.buildTags.length === 0) {
    throw new Error('Mihomo manifest buildTags must be a non-empty array');
  }
  for (const tag of manifest.buildTags) assertNonEmptyString(tag, 'buildTags entry');

  assertRecord(manifest.binary, 'binary');
  assertDistributionFileName(manifest.binary.file, 'binary.file');
  assertPositiveSafeInteger(manifest.binary.size, 'binary.size');
  assertHex(manifest.binary.sha256, 64, 'binary.sha256');
  const authenticodeFields = [
    manifest.binary.unsignedSize,
    manifest.binary.unsignedSha256,
    manifest.binary.authenticodeSubject,
    manifest.binary.authenticodeThumbprint
  ];
  if (authenticodeFields.some((value) => value !== undefined)) {
    if (authenticodeFields.some((value) => value === undefined)) {
      throw new Error('Mihomo manifest binary Authenticode provenance must be complete');
    }
    assertPositiveSafeInteger(manifest.binary.unsignedSize, 'binary.unsignedSize');
    assertHex(manifest.binary.unsignedSha256, 64, 'binary.unsignedSha256');
    assertNonEmptyString(manifest.binary.authenticodeSubject, 'binary.authenticodeSubject');
    assertHex(manifest.binary.authenticodeThumbprint, 40, 'binary.authenticodeThumbprint');
  }
  assertNonEmptyString(manifest.binary.versionOutput, 'binary.versionOutput');
  if (!manifest.binary.versionOutput.includes(`Mihomo Meta v${manifest.version} windows amd64`)) {
    throw new Error('Mihomo manifest binary.versionOutput does not match version/platform/architecture');
  }
  for (const tag of manifest.buildTags) {
    if (!manifest.binary.versionOutput.includes(tag)) {
      throw new Error(`Mihomo manifest binary.versionOutput is missing build tag: ${tag}`);
    }
  }

  assertRecord(manifest.upstreamAsset, 'upstreamAsset');
  assertDistributionFileName(manifest.upstreamAsset.name, 'upstreamAsset.name');
  assertHttpsUrl(manifest.upstreamAsset.url, 'upstreamAsset.url');
  assertPositiveSafeInteger(manifest.upstreamAsset.size, 'upstreamAsset.size');
  assertHex(manifest.upstreamAsset.sha256, 64, 'upstreamAsset.sha256');

  assertRecord(manifest.sourceArchive, 'sourceArchive');
  assertHttpsUrl(manifest.sourceArchive.upstreamUrl, 'sourceArchive.upstreamUrl');
  assertPositiveSafeInteger(manifest.sourceArchive.size, 'sourceArchive.size');
  assertHex(manifest.sourceArchive.sha256, 64, 'sourceArchive.sha256');
  assertNonEmptyString(manifest.sourceArchive.releaseAssetNameTemplate, 'sourceArchive.releaseAssetNameTemplate');
  if (!manifest.sourceArchive.upstreamUrl.includes(manifest.tagCommit)) {
    throw new Error('Mihomo sourceArchive.upstreamUrl must pin tagCommit');
  }

  assertRecord(manifest.license, 'license');
  assertEqual(manifest.license.spdx, 'GPL-3.0-only', 'license.spdx');
  assertDistributionFileName(manifest.license.file, 'license.file');
  assertDistributionFileName(manifest.license.sourceNoticeFile, 'license.sourceNoticeFile');
  resolveMihomoSourceReleaseAssetName(manifest, '0.0.0');
}

function runMihomoVersion(binaryPath) {
  const result = spawnSync(binaryPath, ['-v'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Mihomo binary failed to report its version: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)}`
    );
  }
  return [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n');
}

async function readRequiredText(path, label) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${label} missing or unreadable: ${path}`, { cause: error });
  }
}

async function statRequired(path, label) {
  try {
    const result = await stat(path);
    if (!result.isFile()) throw new Error('not a file');
    return result;
  } catch (error) {
    throw new Error(`${label} missing or unreadable: ${path}`, { cause: error });
  }
}

function resolveDistributionFile(directory, file, label) {
  assertDistributionFileName(file, label);
  return join(directory, file);
}

function normalizeVersionOutput(value) {
  return String(value).replace(/\r\n/g, '\n').trim();
}

function assertDistributionFileName(value, label) {
  assertNonEmptyString(value, label);
  if (basename(value) !== value || value === '.' || value === '..') {
    throw new Error(`Mihomo manifest ${label} must be a single file name`);
  }
}

function assertHttpsUrl(value, label) {
  assertNonEmptyString(value, label);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Mihomo manifest ${label} must be a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`Mihomo manifest ${label} must use HTTPS`);
}

function assertVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('Mihomo manifest version must be an exact stable version');
  }
}

function assertHex(value, length, label) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`Mihomo manifest ${label} must be ${length} lowercase hex characters`);
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Mihomo manifest ${label} must be a positive safe integer`);
  }
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new Error(`Mihomo manifest ${label} must be an object`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Mihomo manifest ${label} must be a non-empty string`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Mihomo manifest ${label} must be ${JSON.stringify(expected)}`);
  }
}

function resolveTarExecutable() {
  if (process.platform !== 'win32') return 'tar';
  const root = (process.env.SystemRoot ?? 'C:\\Windows').trim();
  return join(root, 'System32', 'tar.exe');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
