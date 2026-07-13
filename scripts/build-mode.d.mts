export interface BuildMode {
  internalBuild: boolean;
  noPetBuild: boolean;
  publicUpdateBuild: boolean;
  buildChannel: 'standard' | 'in' | 'no';
}

export function resolveBuildMode(args?: readonly string[]): BuildMode;
export function createBuildEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  mode: BuildMode
): NodeJS.ProcessEnv & {
  YOUYU_BUILD_CHANNEL: BuildMode['buildChannel'];
  YOUYU_DISABLE_PET: '0' | '1';
};
