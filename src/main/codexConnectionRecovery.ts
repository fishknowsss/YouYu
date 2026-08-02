import type { RuntimeConnectionStats } from '../shared/ipc';

export type CodexConnectionRecoveryApi = {
  closeConnection: (id: string) => Promise<void>;
  flushDnsCache: () => Promise<void>;
};

type CodexConnectionRecoveryOptions = {
  createMihomoApi: () => Promise<CodexConnectionRecoveryApi> | CodexConnectionRecoveryApi;
  readConnections?: () => Promise<readonly RuntimeConnectionStats[]>;
  now?: () => number;
  onRecovered?: (connection: Readonly<RuntimeConnectionStats>) => void | Promise<void>;
  onError?: (error: unknown, connection: Readonly<RuntimeConnectionStats>) => void | Promise<void>;
};

type CodexConnection = RuntimeConnectionStats & { id: string };

type TrackedConnection = {
  startedAt: number;
  noResponseSamples: number;
};

type ScheduledRecheck = {
  connectionId: string;
  connection: CodexConnection;
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
};

const codexProcessName = 'codex.exe';
const openAiDomains = ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com'];
const requiredNoResponseSamples = 2;
const minimumStallMs = 8_000;
const recoveryCooldownMs = 30_000;
const maximumInitialUploadBytes = 8 * 1024;

export function createCodexConnectionRecoveryCoordinator(options: CodexConnectionRecoveryOptions) {
  const trackedConnections = new Map<string, TrackedConnection>();
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  let activeRecovery: Promise<void> | undefined;
  let scheduledRecheck: ScheduledRecheck | undefined;
  let generation = 0;

  function now(): number {
    return options.now?.() ?? Date.now();
  }

  function normalizeText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized || undefined;
  }

  function normalizeProcessName(value: unknown): string | undefined {
    const text = normalizeText(value);
    if (!text) return undefined;
    return text.split(/[\\/]/).at(-1)?.toLowerCase();
  }

  function normalizeHost(value: unknown): string | undefined {
    const text = normalizeText(value)?.toLowerCase();
    return text?.replace(/\.+$/, '') || undefined;
  }

  function isOpenAiHost(value: unknown): boolean {
    const host = normalizeHost(value);
    return Boolean(host && openAiDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
  }

  function normalizeByteCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  function isFiniteNonNegativeByteCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function connectionStartedAt(connection: RuntimeConnectionStats, observedAt: number): number {
    const parsed = Date.parse(connection.start ?? '');
    return Number.isFinite(parsed) && parsed <= observedAt ? parsed : observedAt;
  }

  function isInitialCodexConnection(connection: RuntimeConnectionStats): connection is CodexConnection {
    const id = normalizeText(connection.id);
    if (!id) return false;
    const metadata = connection.metadata;
    if (normalizeProcessName(metadata?.process) !== codexProcessName) return false;
    if (normalizeText(metadata?.network)?.toLowerCase() !== 'tcp') return false;
    if (!isOpenAiHost(metadata?.host)) return false;
    if (!isFiniteNonNegativeByteCount(connection.upload) || !isFiniteNonNegativeByteCount(connection.download)) {
      return false;
    }
    return (
      normalizeByteCount(connection.download) === 0 &&
      normalizeByteCount(connection.upload) <= maximumInitialUploadBytes
    );
  }

  async function reportError(error: unknown, connection: RuntimeConnectionStats): Promise<void> {
    try {
      await options.onError?.(error, connection);
    } catch {
      // A reporting callback must never cause the background guard to retry or throw.
    }
  }

  async function recover(connection: CodexConnection): Promise<void> {
    try {
      const api = await options.createMihomoApi();
      await api.closeConnection(connection.id);
      await api.flushDnsCache();
      await options.onRecovered?.(connection);
    } catch (error) {
      await reportError(error, connection);
    }
  }

  function cancelScheduledRecheck(): void {
    const scheduled = scheduledRecheck;
    if (!scheduled) return;
    if (scheduled.timer !== undefined) clearTimeout(scheduled.timer);
    scheduledRecheck = undefined;
  }

  async function runScheduledRecheck(scheduled: ScheduledRecheck): Promise<void> {
    if (scheduledRecheck !== scheduled || scheduled.generation !== generation || !options.readConnections) return;
    try {
      const connections = await options.readConnections();
      if (scheduledRecheck !== scheduled || scheduled.generation !== generation) return;
      await observe(connections, false);
    } catch (error) {
      if (scheduledRecheck === scheduled && scheduled.generation === generation) {
        await reportError(error, scheduled.connection);
      }
    } finally {
      if (scheduledRecheck === scheduled) scheduledRecheck = undefined;
    }
  }

  function scheduleRecheck(
    connection: CodexConnection,
    connectionId: string,
    startedAt: number,
    observedAt: number
  ): void {
    if (
      !options.readConnections ||
      scheduledRecheck ||
      activeRecovery ||
      observedAt - lastRecoveryAt < recoveryCooldownMs
    ) {
      return;
    }

    const scheduled: ScheduledRecheck = {
      connectionId,
      connection,
      generation
    };
    const delayMs = Math.max(0, startedAt + minimumStallMs - observedAt);
    const timer = setTimeout(() => {
      void runScheduledRecheck(scheduled);
    }, delayMs);
    timer.unref?.();
    scheduled.timer = timer;
    scheduledRecheck = scheduled;
  }

  function startRecovery(connection: CodexConnection): Promise<void> {
    cancelScheduledRecheck();
    const recovery = recover(connection);
    activeRecovery = recovery;
    void recovery.finally(() => {
      if (activeRecovery === recovery) activeRecovery = undefined;
    });
    return recovery;
  }

  async function observe(connections: readonly RuntimeConnectionStats[], allowScheduledRecheck = true): Promise<void> {
    const observedAt = now();
    const liveConnectionIds = new Set<string>();
    const liveCandidateIds = new Set<string>();
    let candidate: CodexConnection | undefined;

    for (const connection of connections) {
      const id = normalizeText(connection.id);
      if (!id) continue;
      liveConnectionIds.add(id);

      if (!isInitialCodexConnection(connection)) {
        trackedConnections.delete(id);
        continue;
      }
      liveCandidateIds.add(id);

      const previous = trackedConnections.get(id);
      const tracked: TrackedConnection = previous ?? {
        startedAt: connectionStartedAt(connection, observedAt),
        noResponseSamples: 0
      };
      tracked.noResponseSamples += 1;
      trackedConnections.set(id, tracked);

      if (allowScheduledRecheck) {
        scheduleRecheck(connection, id, tracked.startedAt, observedAt);
      }

      const stalledForMs = observedAt - tracked.startedAt;
      if (
        !candidate &&
        tracked.noResponseSamples >= requiredNoResponseSamples &&
        stalledForMs >= minimumStallMs &&
        observedAt - lastRecoveryAt >= recoveryCooldownMs
      ) {
        candidate = connection;
      }
    }

    for (const id of trackedConnections.keys()) {
      if (!liveConnectionIds.has(id)) trackedConnections.delete(id);
    }
    if (scheduledRecheck && !liveCandidateIds.has(scheduledRecheck.connectionId)) {
      cancelScheduledRecheck();
    }

    if (!candidate || activeRecovery) return;
    lastRecoveryAt = observedAt;
    trackedConnections.delete(normalizeText(candidate.id) ?? candidate.id);
    await startRecovery(candidate);
  }

  function reset(): void {
    generation += 1;
    cancelScheduledRecheck();
    trackedConnections.clear();
  }

  return { observe, reset };
}
