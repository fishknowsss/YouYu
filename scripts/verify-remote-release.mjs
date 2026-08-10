import { spawn } from 'node:child_process';
import { mkdir, readFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import packageJson from '../package.json' with { type: 'json' };
import { verifyReleaseSha256Manifest } from './release-sha256-manifest.mjs';

const repository = 'fishknowsss/YouYu';
const apiBaseUrl = `https://api.github.com/repos/${repository}/releases`;
const preflightBytes = 2 * 1024 * 1024;
const defaultMinimumBytesPerSecond = 64 * 1024;
const expectedChannelAssets = ['latest.yml', 'latest-in.yml', 'latest-no.yml'];

export function getExpectedPublicAssetNames(version, sourceName) {
  assertVersion(version);
  return [
    `YouYu-${version}-x64.exe`,
    `YouYu-${version}-x64.exe.blockmap`,
    `YouYu-${version}-x64-in.exe`,
    `YouYu-${version}-x64-in.exe.blockmap`,
    `YouYu-${version}-x64-no.exe`,
    `YouYu-${version}-x64-no.exe.blockmap`,
    ...expectedChannelAssets,
    sourceName,
    'SHA256SUMS.txt'
  ].sort();
}

export function describeEffectiveProxy(environment = process.env) {
  const entry = [
    ['HTTPS_PROXY', environment.HTTPS_PROXY ?? environment.https_proxy],
    ['HTTP_PROXY', environment.HTTP_PROXY ?? environment.http_proxy],
    ['ALL_PROXY', environment.ALL_PROXY ?? environment.all_proxy]
  ].find(([, value]) => typeof value === 'string' && value.trim());
  if (!entry) return { label: '未配置代理环境变量，将使用默认网络路由', proxyConfigured: false };

  const [name, rawValue] = entry;
  try {
    const url = new URL(rawValue);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const authority = url.port ? `${host}:${url.port}` : host;
    return { label: `${name} ${url.protocol}//${authority}`, proxyConfigured: true };
  } catch {
    return { label: `${name} 已配置（地址格式未识别）`, proxyConfigured: true };
  }
}

export function validateReleaseAssetNames(release, expectedNames) {
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets)) {
    throw new Error('GitHub Release API response does not contain an asset list');
  }
  if (release.draft) throw new Error('GitHub Release is still a draft');
  if (release.prerelease) throw new Error('GitHub Release is marked as a prerelease');
  const actualNames = release.assets
    .map((asset) => asset?.name)
    .filter((name) => typeof name === 'string')
    .sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error(
      `Remote release asset list mismatch\nexpected: ${expectedNames.join(', ')}\nactual: ${actualNames.join(', ')}`
    );
  }
  return release.assets;
}

export function validateChannelMetadata(name, source, version) {
  const metadata = parseYaml(source);
  if (!metadata || typeof metadata !== 'object') throw new Error(`${name} is not valid update metadata`);
  if (String(metadata.version) !== version) throw new Error(`${name} points to version ${String(metadata.version)}`);
  const expectedInstaller =
    name === 'latest-in.yml'
      ? `YouYu-${version}-x64-in.exe`
      : name === 'latest-no.yml'
        ? `YouYu-${version}-x64-no.exe`
        : `YouYu-${version}-x64.exe`;
  const paths = [metadata.path, ...(Array.isArray(metadata.files) ? metadata.files.map((file) => file?.url) : [])];
  if (!paths.some((value) => value === expectedInstaller)) {
    throw new Error(`${name} does not point to ${expectedInstaller}`);
  }
}

export function parseCurlMetrics(output) {
  const match = output.trim().match(/http=(\d+) bytes=(\d+) speed=(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error(`Unable to parse curl preflight metrics: ${output.trim() || 'empty output'}`);
  return { httpCode: Number(match[1]), bytes: Number(match[2]), bytesPerSecond: Number(match[3]) };
}

export function resolveGitHubApiEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.username || url.password) {
    throw new Error('GitHub API URL is invalid');
  }
  return `${url.pathname.replace(/^\/+/, '')}${url.search}`;
}

export async function preflightReleaseCdn({ temporaryDirectory, environment = process.env } = {}) {
  const ownedTemporaryDirectory = temporaryDirectory
    ? undefined
    : await mkdtemp(join(tmpdir(), 'youyu-cdn-preflight-'));
  const directory = temporaryDirectory ?? ownedTemporaryDirectory;
  try {
    const latestPath = join(directory, 'latest-release.json');
    await downloadGitHubApiFile(`${apiBaseUrl}/latest`, latestPath, environment);
    const latestRelease = JSON.parse(await readFile(latestPath, 'utf8'));
    const installer = latestRelease.assets?.find((asset) => /^YouYu-\d+\.\d+\.\d+-x64\.exe$/.test(asset?.name));
    if (!installer?.browser_download_url)
      throw new Error('Latest GitHub Release does not contain the standard installer');

    const probePath = join(directory, 'cdn-probe.bin');
    const result = await runCurl(
      [
        '--silent',
        '--show-error',
        '--ssl-no-revoke',
        '--fail',
        '--location',
        '--retry',
        '2',
        '--retry-all-errors',
        '--connect-timeout',
        '10',
        '--max-time',
        '35',
        '--max-filesize',
        String(preflightBytes),
        '--range',
        `0-${preflightBytes - 1}`,
        '--output',
        probePath,
        '--write-out',
        'http=%{http_code} bytes=%{size_download} speed=%{speed_download}',
        installer.browser_download_url
      ],
      environment,
      true
    );
    const metrics = parseCurlMetrics(result.stdout);
    const minimumBytesPerSecond = resolveMinimumBytesPerSecond(environment.YOUYU_RELEASE_MIN_CDN_BPS);
    if (metrics.httpCode !== 206 && metrics.httpCode !== 200) {
      throw new Error(`CDN preflight returned HTTP ${metrics.httpCode}`);
    }
    if (metrics.bytes < Math.min(preflightBytes, Number(installer.size) || preflightBytes)) {
      throw new Error(`CDN preflight received only ${metrics.bytes} bytes`);
    }
    if (metrics.bytesPerSecond < minimumBytesPerSecond) {
      throw new Error(
        `CDN route is too slow: ${formatRate(metrics.bytesPerSecond)} (minimum ${formatRate(minimumBytesPerSecond)})`
      );
    }
    return { ...metrics, route: describeEffectiveProxy(environment).label, assetName: installer.name };
  } catch (error) {
    const route = describeEffectiveProxy(environment).label;
    throw new Error(
      `GitHub CDN route preflight failed through ${route}. Keep the verified proxy environment and retry; do not force a direct route. ${formatError(error)}`,
      { cause: error }
    );
  } finally {
    if (ownedTemporaryDirectory) await rm(ownedTemporaryDirectory, { recursive: true, force: true });
  }
}

export async function verifyRemoteRelease({ version = packageJson.version, root = process.cwd() } = {}) {
  assertVersion(version);
  const releaseDir = join(root, 'release');
  const manifest = JSON.parse(await readFile(join(root, 'resources/mihomo/win-x64/manifest.json'), 'utf8'));
  const sourceName = manifest.sourceArchive.releaseAssetNameTemplate.replace('${appVersion}', version);
  const expectedNames = getExpectedPublicAssetNames(version, sourceName);
  await verifyReleaseSha256Manifest({ releaseDir, version });

  const temporaryDirectory = await mkdtemp(join(tmpdir(), `youyu-remote-release-${version}-`));
  try {
    const route = describeEffectiveProxy();
    console.log(`CDN route: ${route.label}`);
    const preflight = await preflightReleaseCdn({ temporaryDirectory });
    console.log(`CDN preflight: ${formatRate(preflight.bytesPerSecond)} via ${preflight.route}`);

    const releaseJsonPath = join(temporaryDirectory, 'release.json');
    await downloadGitHubApiFile(`${apiBaseUrl}/tags/v${version}`, releaseJsonPath);
    const release = JSON.parse(await readFile(releaseJsonPath, 'utf8'));
    if (release.tag_name !== `v${version}`) throw new Error(`Remote release tag is ${String(release.tag_name)}`);
    const assets = validateReleaseAssetNames(release, expectedNames);

    const remoteDirectory = join(temporaryDirectory, 'assets');
    await mkdir(remoteDirectory);
    for (const name of orderAssetDownloads(expectedNames)) {
      const asset = assets.find((candidate) => candidate.name === name);
      const destination = join(remoteDirectory, name);
      console.log(`Downloading ${name}`);
      await downloadLargeFile(asset.browser_download_url, destination);
      const downloaded = await stat(destination);
      if (downloaded.size !== asset.size) {
        throw new Error(`${name} size mismatch: expected ${asset.size}, received ${downloaded.size}`);
      }
    }

    const result = await verifyReleaseSha256Manifest({ releaseDir: remoteDirectory, version });
    if (result.assetCount !== 10) throw new Error(`Expected 10 SHA256 entries, found ${result.assetCount}`);
    const localManifest = await readFile(join(releaseDir, 'SHA256SUMS.txt'));
    const remoteManifest = await readFile(join(remoteDirectory, 'SHA256SUMS.txt'));
    if (!localManifest.equals(remoteManifest)) throw new Error('Remote SHA256SUMS.txt differs from the local manifest');
    for (const name of expectedChannelAssets) {
      validateChannelMetadata(name, await readFile(join(remoteDirectory, name), 'utf8'), version);
    }
    console.log(`Remote release v${version} verified: 11 assets, 10 SHA256 entries, 3 update channels`);
    return { version, assetCount: expectedNames.length, manifestAssetCount: result.assetCount };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function downloadSmallFile(url, destination, environment = process.env) {
  await runCurl(
    [
      '--silent',
      '--show-error',
      '--ssl-no-revoke',
      '--fail',
      '--location',
      '--retry',
      '3',
      '--retry-all-errors',
      '--connect-timeout',
      '10',
      '--max-time',
      '45',
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      'User-Agent: YouYu-release-verifier',
      '--output',
      destination,
      url
    ],
    environment
  );
}

async function downloadGitHubApiFile(url, destination, environment = process.env) {
  try {
    const result = await runGhApi(resolveGitHubApiEndpoint(url), environment);
    await writeFile(destination, result.stdout, 'utf8');
  } catch {
    await downloadSmallFile(url, destination, environment);
  }
}

async function runGhApi(endpoint, environment = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('gh', ['api', endpoint], {
      cwd: process.cwd(),
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.slice(0, 8 * 1024 * 1024 - stdout.length);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) return reject(new Error(`gh api stopped by ${signal}`));
      if (code) return reject(new Error(`gh api exited with ${code}: ${sanitizeCurlError(stderr)}`));
      if (!stdout.trim()) return reject(new Error('gh api returned an empty response'));
      resolvePromise({ stdout, stderr });
    });
  });
}

async function downloadLargeFile(url, destination) {
  await runCurl([
    '--silent',
    '--show-error',
    '--ssl-no-revoke',
    '--fail',
    '--location',
    '--retry',
    '3',
    '--retry-all-errors',
    '--connect-timeout',
    '15',
    '--speed-limit',
    '32768',
    '--speed-time',
    '60',
    '--continue-at',
    '-',
    '--output',
    destination,
    url
  ]);
}

async function runCurl(args, environment = process.env, captureOutput = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('curl.exe', args, {
      cwd: process.cwd(),
      env: environment,
      windowsHide: true,
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) return reject(new Error(`curl stopped by ${signal}`));
      if (code) return reject(new Error(`curl exited with ${code}: ${sanitizeCurlError(stderr)}`));
      resolvePromise({ stdout, stderr });
    });
  });
}

function orderAssetDownloads(names) {
  const priority = (name) => {
    if (name === 'SHA256SUMS.txt') return 0;
    if (name.endsWith('.yml')) return 1;
    if (name.endsWith('.blockmap')) return 2;
    if (name.endsWith('.tar.gz')) return 3;
    return 4;
  };
  return [...names].sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
}

function resolveMinimumBytesPerSecond(value) {
  if (value === undefined || value === '') return defaultMinimumBytesPerSecond;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 16 * 1024 || parsed > 10 * 1024 * 1024) {
    throw new Error('YOUYU_RELEASE_MIN_CDN_BPS must be between 16384 and 10485760');
  }
  return parsed;
}

function sanitizeCurlError(value) {
  return value
    .replace(/https?:\/\/[^\s/]+/gi, '[remote]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
}

function formatRate(bytesPerSecond) {
  return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Invalid release version: ${String(value)}`);
  }
}

async function run() {
  if (process.argv.includes('--preflight')) {
    const result = await preflightReleaseCdn();
    console.log(`CDN preflight passed: ${formatRate(result.bytesPerSecond)} via ${result.route}`);
    return;
  }
  const versionIndex = process.argv.indexOf('--version');
  const version = versionIndex >= 0 ? process.argv[versionIndex + 1] : packageJson.version;
  await verifyRemoteRelease({ version });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
