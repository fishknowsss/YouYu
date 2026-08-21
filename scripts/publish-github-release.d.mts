export const releaseArtifactProvenanceName: 'RELEASE-PROVENANCE.json';

export type GitHubCommandRunner = (args: string[]) => Promise<string>;

export type BuildWindowsRunMetadata = {
  id: number;
  name: string;
  path: string;
  event: 'push' | 'workflow_dispatch';
  status: string;
  conclusion: string;
  head_branch: string;
  head_sha: string;
  run_attempt: number;
};

export function validateBuildWindowsRun(
  run: BuildWindowsRunMetadata,
  expected: { runId: string; tag: string; commitSha: string }
): BuildWindowsRunMetadata;

export function validateRunArtifactMetadata(
  payload: {
    total_count?: number;
    artifacts?: Array<{
      id?: number;
      name?: string;
      expired?: boolean;
      size_in_bytes?: number;
      workflow_run?: { id?: number; head_branch?: string; head_sha?: string };
    }>;
  },
  expected: { runId: string; tag: string; commitSha: string; artifactName: string }
): {
  id: number;
  name: string;
  expired: false;
  size_in_bytes: number;
  workflow_run: { id: number; head_branch: string; head_sha: string };
};

export function assertPublicReleaseDirectory(directory: string): string;

export function buildReleaseUploadArgs(tag: string, files: string[]): string[];

export function selectStarterAssetIds(
  assets: Array<{ id?: number; name?: string; state?: string }>,
  expectedNames: string[]
): number[];

export function getExpectedPublicAssetNames(version: string, sourceName: string): string[];

export function resolveVersionFromTag(tag: string): string;

export function resolveTagCommitSha(tag: string, runner?: GitHubCommandRunner): Promise<string>;

export function createReleaseArtifactProvenance(options: {
  releaseDir: string;
  version: string;
  tag: string;
  commitSha: string;
  runId: string;
  runAttempt: number;
  event: 'push' | 'workflow_dispatch';
}): Promise<{ provenancePath: string; provenance: Record<string, unknown> }>;

export function verifyDownloadedReleaseArtifact(options: {
  releaseDir: string;
  version: string;
  tag: string;
  commitSha: string;
  runId: string;
  runAttempt: number;
  event: 'push' | 'workflow_dispatch';
}): Promise<{ publicAssetCount: number; manifestAssetCount: number; provenancePath: string }>;

export function downloadVerifiedRunArtifact(
  options: { runId: string; tag: string; version: string; directory: string },
  runner?: GitHubCommandRunner
): Promise<{
  publicAssetCount: number;
  manifestAssetCount: number;
  provenancePath: string;
  commitSha: string;
  artifactId: number;
  runAttempt: number;
  event: 'push' | 'workflow_dispatch';
}>;

export function publishGitHubRelease(
  options: {
    tag: string;
    dir?: string;
    fromRun?: string;
    publish?: boolean;
    title?: string;
    notes?: string;
  },
  dependencies?: { runGh?: GitHubCommandRunner }
): Promise<void>;
