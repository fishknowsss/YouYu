export const releaseSha256ManifestName: 'SHA256SUMS.txt';
export function createReleaseSha256Manifest(options: {
  releaseDir: string;
  version: string;
}): Promise<{ manifestPath: string; assetCount: number }>;
export function verifyReleaseSha256Manifest(options: {
  releaseDir: string;
  version: string;
}): Promise<{ manifestPath: string; assetCount: number }>;
