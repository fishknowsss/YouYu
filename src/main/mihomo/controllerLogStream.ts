type MihomoControllerLogMessage = {
  type?: unknown;
  payload?: unknown;
};

const controllerLogLineLimit = 16 * 1024;
const controllerLogReconnectDelayMs = 1_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function parseControllerLogLine(line: string, onLine: (line: string) => void): void {
  if (!line || line.length > controllerLogLineLimit) return;

  let message: MihomoControllerLogMessage;
  try {
    message = JSON.parse(line) as MihomoControllerLogMessage;
  } catch {
    return;
  }

  if (
    (message.type !== 'warning' && message.type !== 'error') ||
    typeof message.payload !== 'string' ||
    !message.payload.trim()
  ) {
    return;
  }

  onLine(`level=${message.type} msg=${JSON.stringify(message.payload.trim())}`);
}

async function readWarningLogResponse(response: Response, signal: AbortSignal, onLine: (line: string) => void) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`mihomo warning log stream failed: ${response.status}`);
  }
  if (!response.body) {
    throw new Error('mihomo warning log stream returned no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let discardingOversizedLine = false;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });

  const consume = (text: string, flush = false) => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline === -1 ? text.length : newline;
      const segment = text.slice(offset, end).replace(/\r$/, '');

      if (!discardingOversizedLine) {
        if (pending.length + segment.length > controllerLogLineLimit) {
          pending = '';
          discardingOversizedLine = true;
        } else {
          pending += segment;
        }
      }

      if (newline === -1) break;
      if (!discardingOversizedLine) {
        parseControllerLogLine(pending, onLine);
      }
      pending = '';
      discardingOversizedLine = false;
      offset = newline + 1;
    }

    if (flush && !discardingOversizedLine) {
      parseControllerLogLine(pending.replace(/\r$/, ''), onLine);
      pending = '';
    }
  };

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    if (!signal.aborted) {
      consume(decoder.decode(), true);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (signal.aborted) {
      await reader.cancel(signal.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export async function monitorMihomoWarningLogs(options: {
  controllerPort: number;
  secret: string;
  signal: AbortSignal;
  onLine: (line: string) => void;
  fetcher?: typeof fetch;
  reconnectDelayMs?: number;
}): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const url = `http://127.0.0.1:${options.controllerPort}/logs?level=warning`;

  while (!options.signal.aborted) {
    try {
      const response = await fetcher(url, {
        signal: options.signal,
        headers: {
          Authorization: `Bearer ${options.secret}`
        }
      });
      await readWarningLogResponse(response, options.signal, options.onLine);
    } catch {
      if (options.signal.aborted) break;
    }

    try {
      await sleep(options.reconnectDelayMs ?? controllerLogReconnectDelayMs, options.signal);
    } catch {
      break;
    }
  }
}
