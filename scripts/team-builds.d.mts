export const teamBuildsDirectoryName: 'team-builds';

export function getTeamInstallerNames(version: string): [string, string];

export function refreshTeamBuilds(options: { root: string; sourceDir: string; version: string }): Promise<string[]>;
