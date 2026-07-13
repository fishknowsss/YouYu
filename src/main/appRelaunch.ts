export const resumeProxyAfterRelaunchArgument = '--resume-proxy-after-relaunch';

const transientArguments = new Set([resumeProxyAfterRelaunchArgument, '--shutdown-for-install']);

export function buildProxyRelaunchArguments(argumentsAfterExecutable: readonly string[]): string[] {
  return [
    ...argumentsAfterExecutable.filter((argument) => !transientArguments.has(argument)),
    resumeProxyAfterRelaunchArgument
  ];
}
