import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const forbiddenTrackedPathRules = [
  [/(^|\/)\.wrangler\//i, 'Wrangler local state'],
  [/(^|\/)__pycache__\//i, 'Python bytecode cache'],
  [/\.(?:pyc|pyo)$/i, 'Python bytecode'],
  [/(^|\/)(?:release|release-archive|out|dist|coverage|node_modules)\//i, 'generated output'],
  [/^resources\/generated\//i, 'generated package resource'],
  [/^resources\/default-subscription\.in\.txt$/i, 'private bundled subscription'],
  [/(^|\/)\.env(?:\.|$)/i, 'local environment secrets'],
  [/(^|\/)\.dev\.vars(?:\.|$)/i, 'local Worker secrets'],
  [/(^|\/)\.(?:codex|agents|claude)\//i, 'local agent state'],
  [/(^|\/)(?:\.DS_Store|Thumbs\.db|Desktop\.ini)$/i, 'operating-system metadata'],
  [/\.log$/i, 'local log output']
];

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

function run() {
  const trackedPaths = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
    encoding: 'utf8',
    windowsHide: true
  }).split('\0');
  const existingTrackedPaths = keepExistingTrackedPaths(trackedPaths);
  const findings = findForbiddenTrackedPaths(existingTrackedPaths);
  const publicSubscription = readFileSync(resolve('resources/default-subscription.txt'), 'utf8');

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
