import { stripUpdateRelaunchAcknowledgementArguments } from './updateRelaunchAcknowledgement';

export const resumeProxyAfterRelaunchArgument = '--resume-proxy-after-relaunch';
export const updateInstallFailedRelaunchArgument = '--update-install-failed';

const transientArguments = new Set([
  resumeProxyAfterRelaunchArgument,
  '--shutdown-for-install',
  updateInstallFailedRelaunchArgument
]);

export function buildProxyRelaunchArguments(argumentsAfterExecutable: readonly string[]): string[] {
  return [
    ...stripUpdateRelaunchAcknowledgementArguments(argumentsAfterExecutable).filter(
      (argument) => !transientArguments.has(argument)
    ),
    resumeProxyAfterRelaunchArgument
  ];
}
