import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const forbiddenTrackedPathRules = [
  [/(^|\/)\.wrangler\//i, 'Wrangler local state'],
  [/(^|\/)__pycache__\//i, 'Python bytecode cache'],
  [/\.(?:pyc|pyo)$/i, 'Python bytecode'],
  [/(^|\/)(?:release|release-archive|out|dist|coverage|node_modules)\//i, 'generated output'],
  [
    /(^|\/)(?:team-builds|local-subscription-builds|\.team-builds-previous|\.team-builds-staging-[^/]+)\//i,
    'private team build'
  ],
  [/^resources\/generated\//i, 'generated package resource'],
  [/^resources\/default-subscription\.in\.txt$/i, 'private bundled subscription'],
  [/(^|\/)\.env(?!\.example$)(?:\.|$)/i, 'local environment secrets'],
  [/(^|\/)\.dev\.vars(?:\.|$)/i, 'local Worker secrets'],
  [/(^|\/)\.(?:codex|agents|claude)\//i, 'local agent state'],
  [/(^|\/)(?:\.DS_Store|Thumbs\.db|Desktop\.ini)$/i, 'operating-system metadata'],
  [/\.log$/i, 'local log output'],
  [/(^|\/)(?:\.idea|\.vs|\.vscode)\//i, 'local IDE state'],
  [/(^|\/)\.eslintcache$/i, 'local lint cache'],
  [/\.tsbuildinfo$/i, 'TypeScript incremental cache'],
  [/(^|\/)(?:playwright-report|test-results|\.nyc_output)\//i, 'generated test output'],
  [/\.(?:cpuprofile|heapprofile|heapsnapshot|dmp|crash)$/i, 'local diagnostic dump'],
  [/\.(?:pfx|p12|key|ppk|jks|keystore)$/i, 'private signing material']
];
const privateKeyMarkerPattern = /-----BEGIN (?:[A-Z0-9][A-Z0-9 ]* )?PRIVATE KEY-----/;
const privateKeyGitPattern = '-----BEGIN ([A-Z0-9][A-Z0-9 ]* )?PRIVATE KEY-----';

export function findForbiddenTrackedPaths(paths) {
  const findings = [];

  for (const originalPath of paths) {
    const path = originalPath.replaceAll('\\', '/');
    const rule = forbiddenTrackedPathRules.find(([pattern]) => pattern.test(path));
    if (rule) findings.push({ path, reason: rule[1] });
  }

  return findings;
}

export function keepExistingTrackedPaths(paths, pathExists = (path) => existsSync(resolve(path))) {
  return paths.filter((path) => path && pathExists(path));
}

export function findPrivateKeyContentFindings(files) {
  return files
    .filter((file) => privateKeyMarkerPattern.test(file.source))
    .map((file) => ({ path: file.path.replaceAll('\\', '/'), reason: 'private key in repository text' }));
}

export function findUnpinnedGitHubActions(workflows) {
  const findings = [];

  for (const workflow of workflows) {
    const lines = workflow.source.split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)['"]?(?:\s+#.*)?$/);
      if (!match) return;
      const action = match[1];
      if (action.startsWith('./') || action.startsWith('docker://')) return;
      const separator = action.lastIndexOf('@');
      const revision = separator >= 0 ? action.slice(separator + 1) : '';
      if (/^[a-f0-9]{40}$/i.test(revision)) return;
      findings.push({ path: workflow.path, line: index + 1, action });
    });
  }

  return findings;
}

export function listRepositoryCandidatePaths(repositoryRoot = process.cwd()) {
  return execFileSync(
    'git',
    ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true
    }
  )
    .split('\0')
    .filter(Boolean);
}

export function findRepositoryPrivateKeyPaths(repositoryRoot = process.cwd()) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.quotepath=false',
      'grep',
      '--untracked',
      '--exclude-standard',
      '-I',
      '-l',
      '-z',
      '-E',
      '-e',
      privateKeyGitPattern,
      '--'
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git grep failed with exit ${result.status}`);
  return result.stdout.split('\0').filter(Boolean);
}

function run() {
  const repositoryRoot = resolve('.');
  const candidatePaths = listRepositoryCandidatePaths(repositoryRoot);
  const existingCandidatePaths = keepExistingTrackedPaths(candidatePaths, (path) =>
    existsSync(resolve(repositoryRoot, path))
  );
  const findings = findForbiddenTrackedPaths(existingCandidatePaths);
  for (const path of findRepositoryPrivateKeyPaths(repositoryRoot)) {
    const normalizedPath = path.replaceAll('\\', '/');
    if (!findings.some((finding) => finding.path === normalizedPath)) {
      findings.push({ path: normalizedPath, reason: 'private key in repository text' });
    }
  }
  const publicSubscription = readFileSync(resolve('resources/default-subscription.txt'), 'utf8');
  const workflowRoot = resolve('.github', 'workflows');
  const workflows = existsSync(workflowRoot)
    ? readdirSync(workflowRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
        .map((entry) => ({
          path: `.github/workflows/${entry.name}`,
          source: readFileSync(resolve(workflowRoot, entry.name), 'utf8')
        }))
    : [];

  for (const finding of findUnpinnedGitHubActions(workflows)) {
    findings.push({
      path: `${finding.path}:${finding.line}`,
      reason: `GitHub Action must be pinned to a full commit SHA (${finding.action})`
    });
  }

  if (publicSubscription.trim()) {
    findings.push({
      path: 'resources/default-subscription.txt',
      reason: 'public bundled subscription must remain empty'
    });
  }

  if (findings.length > 0) {
    console.error('Repository hygiene validation failed:');
    for (const finding of findings) console.error(`- ${finding.path}: ${finding.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log('repository hygiene ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
