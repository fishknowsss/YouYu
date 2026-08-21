import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseSha256Manifest } from './release-sha256-manifest.mjs';
import { validateChannelMetadata } from './verify-remote-release.mjs';

const repository = 'fishknowsss/YouYu';
const buildWindowsWorkflowName = 'Build Windows';
const buildWindowsWorkflowPath = '.github/workflows/build-windows.yml';
export const releaseArtifactProvenanceName = 'RELEASE-PROVENANCE.json';

export function validateBuildWindowsRun(run, { runId, tag, commitSha }) {
  const expectedRunId = assertRunId(runId);
  resolveVersionFromTag(tag);
  assertCommitSha(commitSha);
  if (!run || typeof run !== 'object') throw new Error('Build Windows run metadata is missing');
  if (Number(run.id) !== expectedRunId) throw new Error(`Build Windows run id does not match ${expectedRunId}`);
  if (run.name !== buildWindowsWorkflowName) throw new Error(`run ${expectedRunId} is not ${buildWindowsWorkflowName}`);
  const workflowPath = String(run.path ?? '').split('@')[0];
  if (workflowPath !== buildWindowsWorkflowPath && !workflowPath.endsWith(`/${buildWindowsWorkflowPath}`)) {
    throw new Error(`run ${expectedRunId} came from the wrong workflow path`);
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Build Windows run ${expectedRunId} is not completed successfully`);
  }
  if (run.event !== 'push' && run.event !== 'workflow_dispatch') {
    throw new Error(`Build Windows run ${expectedRunId} has unsupported event ${String(run.event)}`);
  }
  if (run.head_branch !== tag) throw new Error(`Build Windows run ${expectedRunId} is not bound to tag ${tag}`);
  if (run.head_sha !== commitSha) throw new Error(`Build Windows run ${expectedRunId} commit does not match the tag`);
  if (!Number.isInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error(`Build Windows run ${expectedRunId} has invalid attempt metadata`);
  }
  return run;
}

export function validateRunArtifactMetadata(payload, { runId, tag, commitSha, artifactName }) {
  const expectedRunId = assertRunId(runId);
  resolveVersionFromTag(tag);
  assertCommitSha(commitSha);
  if (!artifactName) throw new Error('artifact name is required');
  const artifacts = Array.isArray(payload?.artifacts)
    ? payload.artifacts.filter((artifact) => artifact?.name === artifactName)
    : [];
  if (Number(payload?.total_count) !== 1 || artifacts.length !== 1) {
    throw new Error(`expected exactly one ${artifactName} artifact for run ${expectedRunId}`);
  }
  const artifact = artifacts[0];
  if (!Number.isInteger(artifact.id) || artifact.id < 1) throw new Error('artifact id is invalid');
  if (artifact.expired) throw new Error(`artifact ${artifactName} is expired`);
  if (!Number.isInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1) {
    throw new Error(`artifact ${artifactName} has invalid size metadata`);
  }
  if (Number(artifact.workflow_run?.id) !== expectedRunId) {
    throw new Error(`artifact ${artifactName} is bound to a different run`);
  }
  if (artifact.workflow_run?.head_branch !== tag) {
    throw new Error(`artifact ${artifactName} is bound to a different tag`);
  }
  if (artifact.workflow_run?.head_sha !== commitSha) {
    throw new Error(`artifact ${artifactName} commit does not match the tag`);
  }
  return artifact;
}

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

export async function resolveTagCommitSha(tag, gh = runGh) {
  resolveVersionFromTag(tag);
  const reference = parseGitHubJson(
    await gh(['api', `repos/${repository}/git/ref/tags/${tag}`]),
    `tag reference ${tag}`
  );
  if (reference?.ref !== `refs/tags/${tag}`) throw new Error(`tag reference does not match ${tag}`);
  let object = reference.object;
  for (let depth = 0; depth < 5; depth += 1) {
    const sha = assertCommitSha(object?.sha);
    if (object?.type === 'commit') return sha;
    if (object?.type !== 'tag') throw new Error(`tag ${tag} does not resolve to a commit`);
    const annotated = parseGitHubJson(await gh(['api', `repos/${repository}/git/tags/${sha}`]), `annotated tag ${sha}`);
    object = annotated?.object;
  }
  throw new Error(`tag ${tag} has too many annotation levels`);
}

export async function downloadVerifiedRunArtifact(options, gh = runGh) {
  const tag = options?.tag;
  const version = resolveVersionFromTag(tag);
  if (options?.version !== version) throw new Error(`artifact version ${String(options?.version)} does not match tag`);
  const runId = String(assertRunId(options?.runId));
  const directory = resolve(assertPublicReleaseDirectory(options?.directory));
  await assertEmptyArtifactDestination(directory);
  const commitSha = await resolveTagCommitSha(tag, gh);
  const run = validateBuildWindowsRun(
    parseGitHubJson(await gh(['api', `repos/${repository}/actions/runs/${runId}`]), `Build Windows run ${runId}`),
    { runId, tag, commitSha }
  );
  const artifactName = `youyu-windows-x64-${version}`;
  const artifact = validateRunArtifactMetadata(
    parseGitHubJson(
      await gh([
        'api',
        `repos/${repository}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`
      ]),
      `artifact list for run ${runId}`
    ),
    { runId, tag, commitSha, artifactName }
  );
  await mkdir(dirname(directory), { recursive: true });
  let stagingDirectory = await mkdtemp(join(dirname(directory), '.youyu-release-artifact-'));
  try {
    await downloadRunArtifact(runId, version, stagingDirectory, gh);
    const verification = await verifyDownloadedReleaseArtifact({
      releaseDir: stagingDirectory,
      version,
      tag,
      commitSha,
      runId,
      runAttempt: run.run_attempt,
      event: run.event
    });
    await rm(directory, { recursive: true, force: true });
    await rename(stagingDirectory, directory);
    stagingDirectory = '';
    return {
      ...verification,
      provenancePath: join(directory, releaseArtifactProvenanceName),
      commitSha,
      artifactId: artifact.id,
      runAttempt: run.run_attempt,
      event: run.event
    };
  } finally {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function createReleaseArtifactProvenance(options) {
  const expected = normalizeArtifactIdentity(options);
  const files = await listDirectoryAssets(expected.releaseDir, expected.version);
  const publicAssets = files.map((file) => basename(file)).sort();
  const manifest = await verifyReleaseSha256Manifest({
    releaseDir: expected.releaseDir,
    version: expected.version
  });
  await validateLocalUpdateChannels(expected.releaseDir, expected.version);
  const manifestSha256 = sha256(await readFile(manifest.manifestPath));
  const provenance = {
    schemaVersion: 1,
    repository,
    workflow: buildWindowsWorkflowName,
    workflowPath: buildWindowsWorkflowPath,
    runId: Number(expected.runId),
    runAttempt: expected.runAttempt,
    event: expected.event,
    ref: `refs/tags/${expected.tag}`,
    tag: expected.tag,
    commitSha: expected.commitSha,
    version: expected.version,
    artifactName: `youyu-windows-x64-${expected.version}`,
    publicAssets,
    manifest: { name: 'SHA256SUMS.txt', sha256: manifestSha256 }
  };
  const provenancePath = join(expected.releaseDir, releaseArtifactProvenanceName);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return { provenancePath, provenance };
}

export async function verifyDownloadedReleaseArtifact(options) {
  const expected = normalizeArtifactIdentity(options);
  const provenancePath = join(expected.releaseDir, releaseArtifactProvenanceName);
  let provenance;
  try {
    provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  } catch (error) {
    throw new Error(`release artifact provenance is missing or invalid: ${formatError(error)}`, { cause: error });
  }
  const expectedFields = {
    schemaVersion: 1,
    repository,
    workflow: buildWindowsWorkflowName,
    workflowPath: buildWindowsWorkflowPath,
    runId: Number(expected.runId),
    runAttempt: expected.runAttempt,
    event: expected.event,
    ref: `refs/tags/${expected.tag}`,
    tag: expected.tag,
    commitSha: expected.commitSha,
    version: expected.version,
    artifactName: `youyu-windows-x64-${expected.version}`
  };
  for (const [field, value] of Object.entries(expectedFields)) {
    if (provenance?.[field] !== value) throw new Error(`release artifact provenance ${field} does not match`);
  }

  const files = await listDirectoryAssets(expected.releaseDir, expected.version);
  const publicAssets = files.map((file) => basename(file)).sort();
  if (JSON.stringify(provenance.publicAssets) !== JSON.stringify(publicAssets)) {
    throw new Error('release artifact provenance public asset list does not match');
  }
  const fileEntries = await readdir(expected.releaseDir, { withFileTypes: true });
  const allowedEntries = new Set([...publicAssets, releaseArtifactProvenanceName]);
  const unexpectedFiles = fileEntries
    .filter((entry) => !entry.isFile() || !allowedEntries.has(entry.name))
    .map((entry) => entry.name);
  if (unexpectedFiles.length)
    throw new Error(`release artifact contains unexpected files: ${unexpectedFiles.join(', ')}`);

  const manifest = await verifyReleaseSha256Manifest({
    releaseDir: expected.releaseDir,
    version: expected.version
  });
  if (manifest.assetCount !== 10) throw new Error(`Expected 10 SHA256 entries, found ${manifest.assetCount}`);
  const manifestSha256 = sha256(await readFile(manifest.manifestPath));
  if (provenance.manifest?.name !== 'SHA256SUMS.txt' || provenance.manifest?.sha256 !== manifestSha256) {
    throw new Error('release artifact provenance manifest digest does not match');
  }
  await validateLocalUpdateChannels(expected.releaseDir, expected.version);
  return { publicAssetCount: publicAssets.length, manifestAssetCount: manifest.assetCount, provenancePath };
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

async function ensureDraftRelease(tag, title, notes, gh = runGh) {
  try {
    const raw = await gh(['release', 'view', tag, '--json', 'id,isDraft']);
    const release = JSON.parse(raw);
    console.log(`using existing release ${tag} draft=${Boolean(release.isDraft)}`);
    return;
  } catch {
    await gh(['release', 'create', tag, '--draft', '--verify-tag', '--title', title, '--notes', notes]);
    console.log(`created draft ${tag}`);
  }
}

async function deleteStarterAssets(tag, expectedNames, gh = runGh) {
  const raw = await gh(['release', 'view', tag, '--json', 'id,assets']);
  const release = JSON.parse(raw);
  const starterIds = selectStarterAssetIds(release.assets ?? [], expectedNames);
  for (const id of starterIds) {
    await gh(['api', '-X', 'DELETE', `repos/${repository}/releases/assets/${id}`]);
    console.log(`deleted starter asset ${id}`);
  }
}

async function downloadRunArtifact(runId, version, directory, gh = runGh) {
  await gh(['run', 'download', String(runId), '--name', `youyu-windows-x64-${version}`, '--dir', directory]);
  console.log(`downloaded Build Windows artifact ${runId} into ${directory}`);
}

function parseArgs(argv) {
  const options = {
    tag: '',
    dir: '',
    fromRun: '',
    publish: false,
    writeProvenance: false,
    runId: '',
    runAttempt: 0,
    commitSha: '',
    event: '',
    title: '',
    notes: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--publish') options.publish = true;
    else if (arg === '--write-provenance') options.writeProvenance = true;
    else if (arg === '--tag') options.tag = argv[++index] ?? '';
    else if (arg === '--dir') options.dir = argv[++index] ?? '';
    else if (arg === '--from-run') options.fromRun = argv[++index] ?? '';
    else if (arg === '--run-id') options.runId = argv[++index] ?? '';
    else if (arg === '--run-attempt') options.runAttempt = Number(argv[++index] ?? '');
    else if (arg === '--commit') options.commitSha = argv[++index] ?? '';
    else if (arg === '--event') options.event = argv[++index] ?? '';
    else if (arg === '--title') options.title = argv[++index] ?? '';
    else if (arg === '--notes') options.notes = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function publishGitHubRelease(options, dependencies = {}) {
  const gh = dependencies.runGh ?? runGh;
  const tag = options.tag;
  const version = resolveVersionFromTag(tag);
  const directory = assertPublicReleaseDirectory(options.dir || 'release');
  if (options.fromRun) {
    await downloadVerifiedRunArtifact({ runId: options.fromRun, tag, version, directory }, gh);
  } else {
    const manifest = await verifyReleaseSha256Manifest({ releaseDir: directory, version });
    if (manifest.assetCount !== 10) throw new Error(`Expected 10 SHA256 entries, found ${manifest.assetCount}`);
    await validateLocalUpdateChannels(directory, version);
  }
  const files = await listDirectoryAssets(directory, version);
  const expectedNames = files.map((file) => basename(file));
  await ensureDraftRelease(tag, options.title || `YouYu ${version}`, options.notes || `YouYu ${version}`, gh);
  await deleteStarterAssets(tag, expectedNames, gh);
  await gh(buildReleaseUploadArgs(tag, files));
  console.log(`uploaded ${files.length} public assets to ${tag}`);
  if (options.publish) {
    await gh(['release', 'edit', tag, '--draft=false']);
    console.log(`published ${tag}`);
  }
}

function normalizeArtifactIdentity(options) {
  const releaseDir = assertPublicReleaseDirectory(options?.releaseDir);
  const version = resolveVersionFromTag(options?.tag);
  if (options?.version !== version) throw new Error(`artifact version ${String(options?.version)} does not match tag`);
  const runId = String(assertRunId(options?.runId));
  const runAttempt = Number(options?.runAttempt);
  if (!Number.isInteger(runAttempt) || runAttempt < 1) throw new Error('invalid Build Windows run attempt');
  const commitSha = assertCommitSha(options?.commitSha);
  if (options?.event !== 'push' && options?.event !== 'workflow_dispatch') {
    throw new Error(`invalid Build Windows event: ${String(options?.event)}`);
  }
  return {
    releaseDir,
    version,
    tag: options.tag,
    commitSha,
    runId,
    runAttempt,
    event: options.event
  };
}

async function assertEmptyArtifactDestination(directory) {
  try {
    const entries = await readdir(directory);
    if (entries.length) throw new Error(`artifact download destination must be empty: ${directory}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof Error && error.message.startsWith('artifact download destination must be empty:')) throw error;
    throw new Error(`artifact download destination is unavailable: ${directory}`, { cause: error });
  }
}

async function validateLocalUpdateChannels(releaseDir, version) {
  for (const name of ['latest.yml', 'latest-in.yml', 'latest-no.yml']) {
    const installer =
      name === 'latest-in.yml'
        ? `YouYu-${version}-x64-in.exe`
        : name === 'latest-no.yml'
          ? `YouYu-${version}-x64-no.exe`
          : `YouYu-${version}-x64.exe`;
    const installerBytes = await readFile(join(releaseDir, installer));
    validateChannelMetadata(name, await readFile(join(releaseDir, name), 'utf8'), version, {
      sha512: createHash('sha512').update(installerBytes).digest('base64'),
      size: installerBytes.length
    });
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseGitHubJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`GitHub returned invalid ${label} metadata`);
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertRunId(value) {
  if (!/^\d+$/.test(String(value ?? '')) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`invalid Build Windows run id: ${String(value)}`);
  }
  return Number(value);
}

function assertCommitSha(value) {
  if (!/^[a-f0-9]{40}$/.test(String(value ?? ''))) throw new Error(`invalid commit SHA: ${String(value)}`);
  return value;
}

async function runCli(argv) {
  const options = parseArgs(argv);
  if (options.writeProvenance) {
    const version = resolveVersionFromTag(options.tag);
    const result = await createReleaseArtifactProvenance({
      releaseDir: options.dir || 'release',
      version,
      tag: options.tag,
      commitSha: options.commitSha,
      runId: options.runId,
      runAttempt: options.runAttempt,
      event: options.event
    });
    console.log(`wrote ${basename(result.provenancePath)} for run ${options.runId}`);
    return;
  }
  await publishGitHubRelease(options);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
