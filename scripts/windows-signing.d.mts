export type WindowsSigningTarget = { role: string; path: string };
export type AuthenticodeRecord = WindowsSigningTarget & {
  status: string;
  subject?: string;
  thumbprint?: string;
  timestampSubject?: string;
};

export const windowsTimestampServer: string;
export function assertWindowsSigningEnvironment(env: NodeJS.ProcessEnv | Record<string, string | undefined>): {
  required: boolean;
  publisherName?: string;
};
export function createWindowsSigningTargets(
  releaseDir: string,
  version: string,
  channel: 'standard' | 'in' | 'no'
): WindowsSigningTarget[];
export function inspectAuthenticodeTargets(targets: WindowsSigningTarget[]): AuthenticodeRecord[];
export function validateAuthenticodeRecords(
  records: AuthenticodeRecord[],
  options: { expectedPublisher?: string }
): { signerThumbprint: string | undefined; targetCount: number };
export function validateWindowsReleaseSignatures(options: {
  releaseDir: string;
  version: string;
  channel: 'standard' | 'in' | 'no';
  expectedPublisher?: string;
}): Promise<{
  signerThumbprint: string | undefined;
  targetCount: number;
  auditPath: string;
  records: AuthenticodeRecord[];
}>;
