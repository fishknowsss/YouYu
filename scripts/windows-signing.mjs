import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const windowsTimestampServer = 'http://timestamp.digicert.com';

export function assertWindowsSigningEnvironment(env) {
  const enforcement = normalizeOptionalString(env.YOUYU_REQUIRE_CODE_SIGNING);
  if (enforcement && enforcement !== '0' && enforcement !== '1') {
    throw new Error('YOUYU_REQUIRE_CODE_SIGNING must be either 0 or 1');
  }

  const signingMaterialNames = [
    'CSC_LINK',
    'WIN_CSC_LINK',
    'CSC_KEY_PASSWORD',
    'WIN_CSC_KEY_PASSWORD',
    'YOUYU_WINDOWS_PUBLISHER_NAME'
  ];
  const detectedSigningMaterials = signingMaterialNames.filter((name) => normalizeOptionalString(env[name]));
  const required = enforcement === '1';
  const publisherName = normalizeOptionalString(env.YOUYU_WINDOWS_PUBLISHER_NAME);
  if (!required && detectedSigningMaterials.length > 0) {
    throw new Error(
      `Windows signing material is configured (${detectedSigningMaterials.join(', ')}) but YOUYU_REQUIRE_CODE_SIGNING is not 1`
    );
  }
  if (!required) return { required: false, publisherName };

  if (!normalizeOptionalString(env.CSC_LINK) && !normalizeOptionalString(env.WIN_CSC_LINK)) {
    throw new Error('YOUYU_REQUIRE_CODE_SIGNING=1 requires CSC_LINK or WIN_CSC_LINK');
  }
  if (!publisherName) {
    throw new Error('YOUYU_REQUIRE_CODE_SIGNING=1 requires YOUYU_WINDOWS_PUBLISHER_NAME');
  }
  return { required: true, publisherName };
}

export function createWindowsSigningTargets(releaseDir, version, channel) {
  const suffix = channel === 'in' ? '-in' : channel === 'no' ? '-no' : '';
  return [
    { role: 'installer', path: join(releaseDir, `YouYu-${version}-x64${suffix}.exe`) },
    { role: 'application', path: join(releaseDir, 'win-unpacked', 'YouYu.exe') },
    {
      role: 'fullscreen-probe',
      path: join(releaseDir, 'win-unpacked', 'resources', 'windows-fullscreen-probe.exe')
    },
    {
      role: 'mihomo-core',
      path: join(releaseDir, 'win-unpacked', 'resources', 'mihomo', 'win-x64', 'mihomo.exe')
    }
  ];
}

export function inspectAuthenticodeTargets(targets) {
  const command = `
$ErrorActionPreference = 'Stop'
$targets = $env:YOUYU_SIGNING_TARGETS_JSON | ConvertFrom-Json
$results = @()
foreach ($target in @($targets)) {
  if (-not (Test-Path -LiteralPath $target.path -PathType Leaf)) {
    $results += [pscustomobject]@{ role = $target.role; path = $target.path; status = 'Missing'; subject = $null; thumbprint = $null; timestampSubject = $null }
    continue
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $target.path
  $results += [pscustomobject]@{
    role = $target.role
    path = $target.path
    status = $signature.Status.ToString()
    subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    timestampSubject = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }
  }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 4
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      env: { ...process.env, YOUYU_SIGNING_TARGETS_JSON: JSON.stringify(targets) }
    }
  );
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`);
    throw new Error(`Authenticode inspection failed: ${reason}`);
  }
  const parsed = JSON.parse(result.stdout.trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function validateAuthenticodeRecords(records, { expectedPublisher }) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('Authenticode target list is empty');
  const normalizedPublisher = normalizeOptionalString(expectedPublisher);
  let signerThumbprint;

  for (const record of records) {
    if (record.status !== 'Valid') {
      throw new Error(`Authenticode ${record.role ?? record.path} status is ${String(record.status)}`);
    }
    const subject = normalizeOptionalString(record.subject);
    const thumbprint = normalizeOptionalString(record.thumbprint)?.toUpperCase();
    if (!subject || !thumbprint) throw new Error(`Authenticode ${record.role ?? record.path} has no signer`);
    if (normalizedPublisher && !matchesUpdaterPublisher(subject, normalizedPublisher)) {
      throw new Error(`Authenticode ${record.role ?? record.path} signer does not match ${expectedPublisher}`);
    }
    if (!normalizeOptionalString(record.timestampSubject)) {
      throw new Error(`Authenticode ${record.role ?? record.path} is missing an RFC3161 timestamp`);
    }
    if (signerThumbprint && signerThumbprint !== thumbprint) {
      throw new Error('Authenticode targets are not signed by the same certificate');
    }
    signerThumbprint = thumbprint;
  }

  return { signerThumbprint, targetCount: records.length };
}

function matchesUpdaterPublisher(subject, expectedPublisher) {
  const subjectFields = parseDistinguishedName(subject);
  const expectedFields = parseDistinguishedName(expectedPublisher);
  if (expectedFields.size > 0) {
    return [...expectedFields].every(([key, value]) => subjectFields.get(key) === value);
  }
  return expectedPublisher === subjectFields.get('CN');
}

// Keep this parser's comparison behavior aligned with electron-updater's RFC2253 parser:
// separators and escaping are normalized, while attribute names and values remain exact.
function parseDistinguishedName(sequence) {
  let quoted = false;
  let key = null;
  let token = '';
  let nextNonSpace = 0;
  const value = sequence.trim();
  const result = new Map();

  for (let index = 0; index <= value.length; index += 1) {
    if (index === value.length) {
      if (key !== null) result.set(key, token);
      break;
    }

    const character = value[index];
    if (quoted) {
      if (character === '"') {
        quoted = false;
        continue;
      }
    } else {
      if (character === '"') {
        quoted = true;
        continue;
      }
      if (character === '\\') {
        index += 1;
        const ordinal = Number.parseInt(value.slice(index, index + 2), 16);
        if (Number.isNaN(ordinal)) {
          token += value[index] ?? '';
        } else {
          index += 1;
          token += String.fromCharCode(ordinal);
        }
        continue;
      }
      if (key === null && character === '=') {
        key = token;
        token = '';
        continue;
      }
      if (character === ',' || character === ';' || character === '+') {
        if (key !== null) result.set(key, token);
        key = null;
        token = '';
        continue;
      }
    }

    if (character === ' ' && !quoted) {
      if (token.length === 0) continue;
      if (index > nextNonSpace) {
        nextNonSpace = index;
        while (value[nextNonSpace] === ' ') nextNonSpace += 1;
      }
      if (
        nextNonSpace >= value.length ||
        value[nextNonSpace] === ',' ||
        value[nextNonSpace] === ';' ||
        (key === null && value[nextNonSpace] === '=') ||
        (key !== null && value[nextNonSpace] === '+')
      ) {
        index = nextNonSpace - 1;
        continue;
      }
    }
    token += character;
  }

  return result;
}

export async function validateWindowsReleaseSignatures({ releaseDir, version, channel, expectedPublisher }) {
  const targets = createWindowsSigningTargets(releaseDir, version, channel);
  const records = inspectAuthenticodeTargets(targets);
  const result = validateAuthenticodeRecords(records, { expectedPublisher });
  const auditPath = join(releaseDir, 'windows-signing-audit.json');
  await writeFile(auditPath, `${JSON.stringify({ schemaVersion: 1, ...result, targets: records }, null, 2)}\n`, 'utf8');
  return { ...result, auditPath, records };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function run() {
  const root = process.cwd();
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const channel = process.argv.includes('--internal') ? 'in' : process.argv.includes('--no-pet') ? 'no' : 'standard';
  const result = await validateWindowsReleaseSignatures({
    releaseDir: join(root, 'release'),
    version: packageJson.version,
    channel,
    expectedPublisher: process.env.YOUYU_WINDOWS_PUBLISHER_NAME
  });
  console.log(`validated Authenticode signatures: ${result.targetCount} targets`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
