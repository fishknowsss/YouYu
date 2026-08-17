export function assertPublicReleaseDirectory(directory: string): string;

export function buildReleaseUploadArgs(tag: string, files: string[]): string[];

export function selectStarterAssetIds(
  assets: Array<{ id?: number; name?: string; state?: string }>,
  expectedNames: string[]
): number[];

export function getExpectedPublicAssetNames(version: string, sourceName: string): string[];

export function resolveVersionFromTag(tag: string): string;

export function publishGitHubRelease(options: {
  tag: string;
  dir?: string;
  fromRun?: string;
  publish?: boolean;
  title?: string;
  notes?: string;
}): Promise<void>;
