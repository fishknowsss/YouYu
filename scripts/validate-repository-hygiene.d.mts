export interface RepositoryHygieneFinding {
  path: string;
  reason: string;
}

export function findForbiddenTrackedPaths(paths: readonly string[]): RepositoryHygieneFinding[];
export function keepExistingTrackedPaths(paths: readonly string[], pathExists?: (path: string) => boolean): string[];
