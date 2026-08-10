import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const version = (await import('../package.json', { with: { type: 'json' } })).default.version;
const sourceDir = resolve(root, process.argv[2] || 'team-builds');
const privateSubscriptionPath = join(root, 'resources', 'default-subscription.in.txt');
const installerNames = [`YouYu-${version}-x64-in.exe`, `YouYu-${version}-x64-no.exe`];
const sevenZipPath = await findSevenZip();
const auditDir = await mkdtemp(join(tmpdir(), `youyu-team-audit-${version}-`));

try {
  const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
  const actualNames = sourceEntries.map((entry) => entry.name).sort();
  const expectedNames = [...installerNames].sort();
  if (sourceEntries.some((entry) => !entry.isFile()) || actualNames.join('\n') !== expectedNames.join('\n')) {
    throw new Error(
      `Private team installer directory must contain exactly: ${expectedNames.join(', ')}; found: ${actualNames.join(', ') || '<empty>'}`
    );
  }

  const expectedSubscription = await readFile(privateSubscriptionPath);
  if (!expectedSubscription.toString('utf8').trim()) {
    throw new Error('Private subscription source is empty');
  }

  for (const installerName of installerNames) {
    const installerPath = join(sourceDir, installerName);
    const installerStat = await stat(installerPath);
    if (!installerStat.isFile() || installerStat.size < 80 * 1024 * 1024) {
      throw new Error(`Invalid private team installer: ${installerPath}`);
    }

    const installerAuditDir = join(auditDir, installerName);
    await extractSubscription(sevenZipPath, installerPath, installerAuditDir);
    const subscriptions = await findFiles(installerAuditDir, (path) =>
      /[\\/]resources[\\/]default-subscription\.txt$/i.test(path)
    );
    if (subscriptions.length !== 1) {
      throw new Error(`${installerName} contains ${subscriptions.length} bundled subscriptions; expected exactly one`);
    }

    const packagedSubscription = await readFile(subscriptions[0]);
    if (!packagedSubscription.equals(expectedSubscription)) {
      throw new Error(`${installerName} bundled subscription does not match resources/default-subscription.in.txt`);
    }

    console.log(`validated private team installer payload: ${installerName}`);
  }
} finally {
  await rm(auditDir, { recursive: true, force: true });
}

async function findSevenZip() {
  const configuredPath = process.env.YOUYU_7ZA_PATH?.trim();
  if (configuredPath) {
    await assertExecutable(configuredPath);
    return configuredPath;
  }

  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new Error('Missing LOCALAPPDATA; set YOUYU_7ZA_PATH to the electron-builder 7za executable');
  }

  const cacheRoot = join(localAppData, 'electron-builder', 'Cache');
  const cacheEntries = await readdir(cacheRoot, { withFileTypes: true });
  const sevenZipRoots = cacheEntries
    .filter((entry) => entry.isDirectory() && /^7zip@/i.test(entry.name))
    .map((entry) => join(cacheRoot, entry.name));
  const matches = (
    await Promise.all(
      sevenZipRoots.map((directory) => findFiles(directory, (path) => /[\\/]7za\.exe$/i.test(path)).catch(() => []))
    )
  )
    .flat()
    .sort();

  if (matches.length === 0) {
    throw new Error('electron-builder 7za executable is unavailable after packaging');
  }

  await assertExecutable(matches.at(-1));
  return matches.at(-1);
}

async function assertExecutable(path) {
  await access(path);
  const entry = await stat(path);
  if (!entry.isFile() || entry.size === 0) {
    throw new Error(`Invalid 7za executable: ${path}`);
  }
}

async function extractSubscription(sevenZip, archive, outputDir) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(sevenZip, ['x', archive, 'resources\\default-subscription.txt', `-o${outputDir}`, '-y'], {
      cwd: root,
      stdio: 'ignore',
      windowsHide: true
    });

    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`7za stopped by ${signal} while extracting ${archive}`));
        return;
      }
      if (code) {
        reject(new Error(`7za exited with ${code} while extracting ${archive}`));
        return;
      }
      resolvePromise();
    });
    child.once('error', reject);
  });
}

async function findFiles(directory, predicate) {
  const matches = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await findFiles(path, predicate)));
    } else if (entry.isFile() && predicate(path)) {
      matches.push(path);
    }
  }
  return matches;
}
