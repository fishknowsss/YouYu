import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { MihomoRuntime } from '../lifecycle';
import type { AppSettings } from '../storage/settings';
import { buildMihomoConfig } from './config';

type SpawnedProcess = {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  kill: () => unknown;
  killed: boolean;
};

export type MihomoRuntimeOptions = {
  binaryPath: string;
  userDataDir: string;
  readSettings: () => Promise<AppSettings>;
  spawnProcess?: (binaryPath: string, args: string[]) => SpawnedProcess;
  waitForReady?: (secret: string) => Promise<void>;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForController(secret: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:9090/version', {
        headers: {
          Authorization: `Bearer ${secret}`
        }
      });
      if (response.ok) return;
    } catch {
      // The controller is not ready yet.
    }
    await sleep(200);
  }
  throw new Error('mihomo controller not ready');
}

async function fetchSubscriptionConfigText(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Clash.Meta/YouYu'
      }
    });
    if (!response.ok) {
      return undefined;
    }
    return await response.text();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export function createMihomoRuntime(options: MihomoRuntimeOptions): MihomoRuntime {
  let child: SpawnedProcess | null = null;

  async function writeConfig() {
    const settings = await options.readSettings();
    if (!settings.subscriptionUrl) {
      throw new Error('missing subscription url');
    }

    const workDir = join(options.userDataDir, 'mihomo');
    const configPath = join(workDir, 'config.yaml');
    const subscriptionConfigText =
      settings.ruleProfile === 'subscription'
        ? await fetchSubscriptionConfigText(settings.subscriptionUrl)
        : undefined;
    await mkdir(workDir, { recursive: true });
    await writeFile(
      configPath,
      buildMihomoConfig({
        subscriptionUrl: settings.subscriptionUrl,
        secret: settings.controllerSecret,
        mode: settings.mode,
        strategy: settings.strategy,
        ruleProfile: settings.ruleProfile,
        systemProxyEnabled: settings.systemProxyEnabled,
        dnsEnhanced: settings.dnsEnhanced,
        snifferEnabled: settings.snifferEnabled,
        tunEnabled: settings.tunEnabled,
        allowLan: settings.allowLan,
        subscriptionConfigText
      }),
      'utf8'
    );

    return { workDir, configPath, settings };
  }

  return {
    async start() {
      if (child && !child.killed) {
        return;
      }

      const { workDir, configPath, settings } = await writeConfig();
      const spawnProcess =
        options.spawnProcess ??
        ((binaryPath: string, args: string[]) =>
          spawn(binaryPath, args, {
            windowsHide: true,
            stdio: 'ignore'
          }));

      const current = spawnProcess(options.binaryPath, ['-d', workDir, '-f', configPath]);
      child = current;

      let ready = false;
      const earlyFailure = new Promise<never>((_resolve, reject) => {
        current.once('error', (error) => {
          if (child === current) {
            child = null;
          }
          reject(error);
        });
        current.once('exit', (code, signal) => {
          if (child === current) {
            child = null;
          }
          if (!ready) {
            const reason =
              code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code.toString()}`;
            reject(new Error(`mihomo exited before controller was ready: ${reason}`));
          }
        });
      });

      await Promise.race([
        (options.waitForReady ?? waitForController)(settings.controllerSecret),
        earlyFailure
      ]);
      ready = true;
    },
    async stop() {
      const current = child;
      if (current && !current.killed) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, 2500);
          current.once('exit', done);
          current.once('error', done);
          current.kill();
        });
      }
      child = null;
    }
  };
}
