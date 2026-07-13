export function resolveBuildMode(args = []) {
  const allowedArguments = new Set(['--internal', '--no-pet', '--public-update']);
  const unknownArguments = args.filter((argument) => !allowedArguments.has(argument));
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown build argument${unknownArguments.length > 1 ? 's' : ''}: ${unknownArguments.join(', ')}`);
  }

  const internalBuild = args.includes('--internal');
  const noPetBuild = args.includes('--no-pet');

  if (internalBuild && noPetBuild) {
    throw new Error('Cannot combine --internal and --no-pet.');
  }

  return {
    internalBuild,
    noPetBuild,
    publicUpdateBuild: args.includes('--public-update'),
    buildChannel: noPetBuild ? 'no' : internalBuild ? 'in' : 'standard'
  };
}

export function createBuildEnvironment(baseEnvironment, mode) {
  return {
    ...baseEnvironment,
    YOUYU_BUILD_CHANNEL: mode.buildChannel,
    YOUYU_DISABLE_PET: mode.noPetBuild ? '1' : '0'
  };
}
