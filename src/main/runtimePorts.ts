import { createServer } from 'node:net';

export type RuntimePorts = {
  mixedPort: number;
  controllerPort: number;
  dnsPort: number;
};

type RuntimePortAllocationOptions = {
  preferredMixedPort?: number;
  preferredSearchWidth?: number;
  randomAttemptLimit?: number;
  isPortAvailable?: (port: number) => Promise<boolean>;
  getEphemeralPort?: () => Promise<number>;
};

async function listenOnPort(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function isPortAvailableByProbe(port: number): Promise<boolean> {
  try {
    const server = await listenOnPort(port);
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

async function getEphemeralPortByProbe(): Promise<number> {
  const server = await listenOnPort(0);
  const address = server.address();
  await closeServer(server);
  return typeof address === 'object' && address ? address.port : 0;
}

function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

export async function allocateDistinctRuntimePorts(options: RuntimePortAllocationOptions = {}): Promise<RuntimePorts> {
  const preferredMixedPort = options.preferredMixedPort ?? 7890;
  const preferredSearchWidth = options.preferredSearchWidth ?? 80;
  const randomAttemptLimit = options.randomAttemptLimit ?? 100;
  const isPortAvailable = options.isPortAvailable ?? isPortAvailableByProbe;
  const getEphemeralPort = options.getEphemeralPort ?? getEphemeralPortByProbe;
  const allocated = new Set<number>();

  const takePreferredPort = async (): Promise<number | undefined> => {
    for (let offset = 0; offset < preferredSearchWidth; offset += 1) {
      const port = preferredMixedPort + offset;
      if (isUsablePort(port) && !allocated.has(port) && (await isPortAvailable(port))) {
        allocated.add(port);
        return port;
      }
    }
    return undefined;
  };

  const takeEphemeralPort = async (): Promise<number> => {
    for (let attempt = 0; attempt < randomAttemptLimit; attempt += 1) {
      const port = await getEphemeralPort();
      if (!isUsablePort(port) || allocated.has(port)) continue;
      allocated.add(port);
      return port;
    }
    throw new Error('unable to allocate distinct runtime ports');
  };

  const mixedPort = (await takePreferredPort()) ?? (await takeEphemeralPort());
  const controllerPort = await takeEphemeralPort();
  const dnsPort = await takeEphemeralPort();
  return { mixedPort, controllerPort, dnsPort };
}
