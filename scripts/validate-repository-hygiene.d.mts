export interface RepositoryHygieneFinding {
  path: string;
  reason: string;
}

export function findForbiddenTrackedPaths(paths: readonly string[]): RepositoryHygieneFinding[];
export function keepExistingTrackedPaths(paths: readonly string[], pathExists?: (path: string) => boolean): string[];
export function findPrivateKeyContentFindings(
  files: readonly { path: string; source: string }[]
): RepositoryHygieneFinding[];
export function findUnpinnedGitHubActions(
  workflows: readonly { path: string; source: string }[]
): Array<{ path: string; line: number; action: string }>;
export function listRepositoryCandidatePaths(repositoryRoot?: string): string[];
export function findRepositoryPrivateKeyPaths(repositoryRoot?: string): string[];
