import { stripUpdateRelaunchAcknowledgementArguments } from './updateRelaunchAcknowledgement';

export const resumeProxyAfterRelaunchArgument = '--resume-proxy-after-relaunch';
export const updateInstallFailedRelaunchArgument = '--update-install-failed';
export const updatedRelaunchArgument = '--updated';

export function shouldReportRecoveredUpdateInstallFailure(options: {
  launchedAfterSuccessfulUpdate: boolean;
  receivedFailedRelaunch: boolean;
}): boolean {
  return options.receivedFailedRelaunch && !options.launchedAfterSuccessfulUpdate;
}

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
