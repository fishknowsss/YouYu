import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPackagedMihomoMatchesSource, hashFileSha256, readMihomoManifest } from './mihomo-distribution.mjs';
import { inspectAuthenticodeTargets, validateAuthenticodeRecords } from './windows-signing.mjs';

export async function reconcilePackagedMihomoAuthenticode({
  sourceDir,
  packagedDir,
  signingRequired = false,
  expectedPublisher,
  inspectSignature = inspectAuthenticodeTargets
}) {
  const sourceManifest = await readMihomoManifest(sourceDir);
  const packagedManifest = await readMihomoManifest(packagedDir);
  if (JSON.stringify(packagedManifest) !== JSON.stringify(sourceManifest)) {
    throw new Error('Packaged Mihomo manifest changed before Authenticode reconciliation');
  }

  const binaryPath = join(packagedDir, packagedManifest.binary.file);
  const [binary, binarySha256] = await Promise.all([stat(binaryPath), hashFileSha256(binaryPath)]);
  if (binary.size === sourceManifest.binary.size && binarySha256 === sourceManifest.binary.sha256) {
    if (signingRequired) throw new Error('Mihomo core was not Authenticode-signed during the required signing build');
    return { signed: false };
  }

  const records = inspectSignature([{ role: 'mihomo-core', path: binaryPath }]);
  validateAuthenticodeRecords(records, { expectedPublisher });
  const signature = records[0];
  const nextManifest = structuredClone(packagedManifest);
  nextManifest.binary.size = binary.size;
  nextManifest.binary.sha256 = binarySha256;
  nextManifest.binary.unsignedSize = sourceManifest.binary.size;
  nextManifest.binary.unsignedSha256 = sourceManifest.binary.sha256;
  nextManifest.binary.authenticodeSubject = signature.subject;
  nextManifest.binary.authenticodeThumbprint = signature.thumbprint.toUpperCase();
  assertPackagedMihomoMatchesSource(sourceManifest, nextManifest);

  const sourceNoticePath = join(packagedDir, packagedManifest.license.sourceNoticeFile);
  const sourceNotice = await readFile(sourceNoticePath, 'utf8');
  const signingNotice = [
    '',
    '## YouYu packaged Authenticode envelope',
    '',
    `Unsigned binary SHA256: ${sourceManifest.binary.sha256}`,
    `Packaged binary SHA256: ${binarySha256}`,
    `Signer subject: ${signature.subject}`,
    `Signer thumbprint: ${signature.thumbprint.toUpperCase()}`,
    ''
  ].join('\n');

  await writeAtomic(join(packagedDir, 'manifest.json'), `${JSON.stringify(nextManifest, null, 2)}\n`);
  await writeAtomic(sourceNoticePath, `${sourceNotice.trimEnd()}\n${signingNotice}`);
  return {
    signed: true,
    signerSubject: signature.subject,
    signerThumbprint: signature.thumbprint.toUpperCase()
  };
}

async function writeAtomic(path, content) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
