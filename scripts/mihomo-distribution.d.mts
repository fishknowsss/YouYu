export interface MihomoDistributionManifest {
  schemaVersion: 1;
  project: string;
  repositoryUrl: string;
  version: string;
  tag: string;
  tagCommit: string;
  platform: 'windows';
  architecture: 'amd64';
  buildTags: string[];
  binary: {
    file: string;
    size: number;
    sha256: string;
    versionOutput: string;
  };
  upstreamAsset: {
    name: string;
    url: string;
    size: number;
    sha256: string;
  };
  sourceArchive: {
    upstreamUrl: string;
    size: number;
    sha256: string;
    releaseAssetNameTemplate: string;
  };
  license: {
    spdx: 'GPL-3.0-only';
    file: string;
    sourceNoticeFile: string;
  };
}

export interface MihomoDistributionValidation {
  manifest: MihomoDistributionManifest;
  binaryPath: string;
  licensePath: string;
  sourceNoticePath: string;
  binarySha256: string;
  versionOutput: string;
}

export const mihomoResourceRelativePath: 'resources/mihomo/win-x64';
export const mihomoManifestFileName: 'manifest.json';

export function readMihomoManifest(distributionDir: string): Promise<MihomoDistributionManifest>;
export function validateMihomoDistribution(
  distributionDir: string,
  options?: { readVersionOutput?: (binaryPath: string) => string | Promise<string> }
): Promise<MihomoDistributionValidation>;
export function resolveMihomoSourceReleaseAssetName(manifest: MihomoDistributionManifest, appVersion: string): string;
export function validateMihomoSourceArchive(
  archivePath: string,
  manifest: MihomoDistributionManifest
): Promise<{ sha256: string; size: number }>;
export function hashFileSha256(path: string): Promise<string>;
