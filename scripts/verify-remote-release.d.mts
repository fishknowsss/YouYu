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

export function resolveReleaseSourceArchiveName(names: string[], version: string): string;

export function describeEffectiveProxy(environment?: Record<string, string | undefined>): {
  label: string;
  proxyConfigured: boolean;
};

export function validateReleaseAssetNames(
  release: ReleasePayload,
  expectedNames: string[],
  expectedTag?: string
): ReleaseAsset[];

export function validateChannelMetadata(
  name: string,
  source: string,
  version: string,
  expectedInstaller: { sha512: string; size: number }
): void;

export function resolveCurlRuntime(platform?: NodeJS.Platform): {
  command: string;
  platformArgs: string[];
};

export function parseCurlMetrics(output: string): {
  httpCode: number;
  bytes: number;
  bytesPerSecond: number;
};

export function resolveGitHubApiEndpoint(value: string): string;

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

export type RemoteReleaseVerificationDependencies = {
  preflightReleaseCdn?: typeof preflightReleaseCdn;
  downloadGitHubApiFile?: (url: string, destination: string) => Promise<void>;
  downloadLargeFile?: (url: string, destination: string) => Promise<void>;
};

export function verifyRemoteRelease(options?: {
  version?: string;
  root?: string;
  dependencies?: RemoteReleaseVerificationDependencies;
}): Promise<{ version: string; assetCount: number; manifestAssetCount: number }>;
