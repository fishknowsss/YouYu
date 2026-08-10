export type ReleaseAsset = {
  name: string;
  size?: number;
  browser_download_url?: string;
};

export type ReleasePayload = {
  draft?: boolean;
  prerelease?: boolean;
  tag_name?: string;
  assets?: ReleaseAsset[];
};

export function getExpectedPublicAssetNames(version: string, sourceName: string): string[];

export function describeEffectiveProxy(environment?: Record<string, string | undefined>): {
  label: string;
  proxyConfigured: boolean;
};

export function validateReleaseAssetNames(release: ReleasePayload, expectedNames: string[]): ReleaseAsset[];

export function validateChannelMetadata(name: string, source: string, version: string): void;

export function parseCurlMetrics(output: string): {
  httpCode: number;
  bytes: number;
  bytesPerSecond: number;
};

export function preflightReleaseCdn(options?: {
  temporaryDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<{
  httpCode: number;
  bytes: number;
  bytesPerSecond: number;
  route: string;
  assetName: string;
}>;

export function verifyRemoteRelease(options?: {
  version?: string;
  root?: string;
}): Promise<{ version: string; assetCount: number; manifestAssetCount: number }>;
