export function archiveWindowsRelease(options: {
  releaseDir: string;
  archiveRoot: string;
  version: string;
  retainCount?: number;
}): Promise<{ archiveDirectory: string; assetCount: number; removedVersions: string[] }>;
