import {
  ipcChannels,
  type AppSettingsInput,
  type ConnectivityServiceKey,
  type MihomoMode,
  type OperationRequest,
  type RuleProfile,
  type StrategyKey,
  type TrafficRegistrationInput
} from '../shared/ipc';

const noArgumentChannels = new Set<string>([
  ipcChannels.getSnapshot,
  ipcChannels.wavePet,
  ipcChannels.startPetDrag,
  ipcChannels.showMainWindow,
  ipcChannels.testAllNodes,
  ipcChannels.cancelNodeTests,
  ipcChannels.testAllConnectivity,
  ipcChannels.closeConnections,
  ipcChannels.exportDiagnostics,
  ipcChannels.checkForUpdates,
  ipcChannels.installUpdate
]);

const optionalOperationChannels = new Set<string>([
  ipcChannels.start,
  ipcChannels.stop,
  ipcChannels.repair,
  ipcChannels.selectBestAutoNode,
  ipcChannels.updateSubscription,
  ipcChannels.syncRemoteConfig
]);

const strategies = new Set<StrategyKey>(['manual', 'auto', 'fallback', 'load-balance', 'direct']);
const modes = new Set<MihomoMode>(['rule', 'global', 'direct']);
const ruleProfiles = new Set<RuleProfile>(['ruleset', 'subscription']);
const connectivityKeys = new Set<ConnectivityServiceKey>([
  'steam',
  'steamNetwork',
  'steamCloud',
  'chatgpt',
  'claude',
  'gemini',
  'flow',
  'pixverse',
  'microsoftStore',
  'discord',
  'turnstile',
  'recaptcha',
  'hcaptcha',
  'google',
  'cloudflare'
]);
const featureBooleanKeys = [
  'systemProxyEnabled',
  'dnsEnhanced',
  'snifferEnabled',
  'tunEnabled',
  'strictRouteEnabled',
  'allowLan'
] as const;
const settingsKeys = new Set<string>([
  ...featureBooleanKeys,
  'subscriptionRefreshIntervalHours',
  'subscriptionUrl',
  'remoteSubscriptionUrl',
  'mode',
  'strategy',
  'ruleProfile',
  'selectedNode',
  'petWindow'
]);
const validRefreshIntervals = new Set([0, 6, 12, 24]);

export class IpcArgumentError extends Error {
  readonly code = 'IPC_ARGUMENT_INVALID';

  constructor(channel: string, field = 'arguments') {
    super(`invalid IPC ${field} for ${channel}`);
    this.name = 'IpcArgumentError';
  }
}

export function parseIpcArguments(channel: string, args: unknown[]): unknown[] {
  if (noArgumentChannels.has(channel)) {
    requireArgumentCount(channel, args, 0);
    return [];
  }
  if (optionalOperationChannels.has(channel)) {
    requireArgumentCount(channel, args, 0, 1);
    return [parseOptionalOperationRequest(channel, args[0])];
  }

  switch (channel) {
    case ipcChannels.stopPetDrag:
      requireArgumentCount(channel, args, 0, 1);
      return [args[0] === undefined ? undefined : parseBoolean(channel, 'moved', args[0])];
    case ipcChannels.setPetMousePassthrough:
      requireArgumentCount(channel, args, 1);
      return [parseBoolean(channel, 'passthrough', args[0])];
    case ipcChannels.selectNode:
    case ipcChannels.testNode:
      requireArgumentCount(channel, args, 1);
      return [parseText(channel, 'name', args[0], 256, true)];
    case ipcChannels.selectStrategy:
      requireArgumentCount(channel, args, 1);
      return [parseEnum(channel, 'strategy', args[0], strategies)];
    case ipcChannels.setMode:
      requireArgumentCount(channel, args, 1);
      return [parseEnum(channel, 'mode', args[0], modes)];
    case ipcChannels.testConnectivity:
      requireArgumentCount(channel, args, 1, 2);
      return [parseEnum(channel, 'key', args[0], connectivityKeys), parseOptionalOperationRequest(channel, args[1])];
    case ipcChannels.saveSettings:
      requireArgumentCount(channel, args, 1, 2);
      return [parseSettingsInput(channel, args[0]), parseOptionalOperationRequest(channel, args[1])];
    case ipcChannels.registerTrafficIdentity:
      requireArgumentCount(channel, args, 1);
      return [parseTrafficRegistration(channel, args[0])];
    case ipcChannels.cancelOperation:
      requireArgumentCount(channel, args, 1);
      return [parseOperationRequestId(channel, args[0])];
    default:
      throw new IpcArgumentError(channel, 'channel');
  }
}

function parseOptionalOperationRequest(channel: string, value: unknown): OperationRequest | undefined {
  if (value === undefined) return undefined;
  const input = parseRecord(channel, 'request', value, new Set(['requestId']));
  return { requestId: parseOperationRequestId(channel, input.requestId) };
}

function parseOperationRequestId(channel: string, value: unknown): string {
  if (typeof value !== 'string') throw new IpcArgumentError(channel, 'requestId');
  const requestId = value.trim();
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) throw new IpcArgumentError(channel, 'requestId');
  return requestId;
}

function parseTrafficRegistration(channel: string, value: unknown): TrafficRegistrationInput {
  const input = parseRecord(channel, 'registration', value, new Set(['name', 'passphrase']));
  return {
    name: parseText(channel, 'name', input.name, 80, true),
    passphrase: parseText(channel, 'passphrase', input.passphrase, 512, true)
  };
}

function parseSettingsInput(channel: string, value: unknown): AppSettingsInput {
  const input = parseRecord(channel, 'settings', value, settingsKeys);
  const parsed: AppSettingsInput = {};

  for (const key of featureBooleanKeys) {
    if (key in input) parsed[key] = parseBoolean(channel, key, input[key]);
  }
  if ('subscriptionRefreshIntervalHours' in input) {
    const interval = input.subscriptionRefreshIntervalHours;
    if (typeof interval !== 'number' || !validRefreshIntervals.has(interval)) {
      throw new IpcArgumentError(channel, 'subscriptionRefreshIntervalHours');
    }
    parsed.subscriptionRefreshIntervalHours = interval;
  }
  if ('subscriptionUrl' in input) {
    parsed.subscriptionUrl = parseText(channel, 'subscriptionUrl', input.subscriptionUrl, 8192, false);
  }
  if ('remoteSubscriptionUrl' in input) {
    parsed.remoteSubscriptionUrl =
      input.remoteSubscriptionUrl === null
        ? null
        : parseText(channel, 'remoteSubscriptionUrl', input.remoteSubscriptionUrl, 8192, false);
  }
  if ('mode' in input) parsed.mode = parseEnum(channel, 'mode', input.mode, modes);
  if ('strategy' in input) parsed.strategy = parseEnum(channel, 'strategy', input.strategy, strategies);
  if ('ruleProfile' in input) {
    parsed.ruleProfile = parseEnum(channel, 'ruleProfile', input.ruleProfile, ruleProfiles);
  }
  if ('selectedNode' in input) {
    parsed.selectedNode =
      input.selectedNode === null ? null : parseText(channel, 'selectedNode', input.selectedNode, 256, false);
  }
  if ('petWindow' in input) {
    if (input.petWindow === null) {
      parsed.petWindow = null;
    } else {
      const position = parseRecord(channel, 'petWindow', input.petWindow, new Set(['x', 'y']));
      parsed.petWindow = {
        x: parseCoordinate(channel, 'petWindow.x', position.x),
        y: parseCoordinate(channel, 'petWindow.y', position.y)
      };
    }
  }

  return parsed;
}

function parseRecord(
  channel: string,
  field: string,
  value: unknown,
  allowedKeys: ReadonlySet<string>
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcArgumentError(channel, field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new IpcArgumentError(channel, field);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new IpcArgumentError(channel, field);
  return input;
}

function parseBoolean(channel: string, field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new IpcArgumentError(channel, field);
  return value;
}

function parseCoordinate(channel: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new IpcArgumentError(channel, field);
  }
  return Math.round(value);
}

function parseText(channel: string, field: string, value: unknown, maxLength: number, required: boolean): string {
  if (typeof value !== 'string') throw new IpcArgumentError(channel, field);
  const text = value.trim();
  const hasControlCharacters = [...text].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if ((required && !text) || text.length > maxLength || hasControlCharacters) {
    throw new IpcArgumentError(channel, field);
  }
  return text;
}

function parseEnum<T extends string>(channel: string, field: string, value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) throw new IpcArgumentError(channel, field);
  return value as T;
}

function requireArgumentCount(channel: string, args: unknown[], minimum: number, maximum = minimum): void {
  if (args.length < minimum || args.length > maximum) throw new IpcArgumentError(channel);
}
