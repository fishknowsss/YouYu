import type { IpcMain, WebContents } from 'electron';
import { canWindowRoleInvokeIpc, type RendererWindowRole } from '../shared/ipc';
import { parseIpcArguments } from './ipcSchemas';

type TrustedIpcMainDependencies = {
  ipcMain: Pick<IpcMain, 'handle'>;
  getMainWebContents: () => WebContents | undefined;
  getNoticeWebContents: () => WebContents | undefined;
  getPetWebContents: () => WebContents | undefined;
  isDev: boolean;
  rendererUrl?: string;
};

function isTrustedRendererUrl(value: string, options: Pick<TrustedIpcMainDependencies, 'isDev' | 'rendererUrl'>) {
  try {
    const url = new URL(value);
    if (options.isDev && options.rendererUrl) {
      return url.origin === new URL(options.rendererUrl).origin;
    }
    return url.protocol === 'file:' && url.pathname.endsWith('/renderer/index.html');
  } catch {
    return false;
  }
}

export function createTrustedIpcMain(dependencies: TrustedIpcMainDependencies): Pick<IpcMain, 'handle'> {
  return {
    handle(channel, listener) {
      return dependencies.ipcMain.handle(channel, async (event, ...args) => {
        const role: RendererWindowRole | undefined =
          event.sender === dependencies.getMainWebContents()
            ? 'main'
            : event.sender === dependencies.getNoticeWebContents()
              ? 'notice'
              : event.sender === dependencies.getPetWebContents()
                ? 'pet'
                : undefined;
        if (
          !role ||
          event.senderFrame !== event.sender.mainFrame ||
          !isTrustedRendererUrl(event.senderFrame.url, dependencies)
        ) {
          throw new Error('untrusted IPC sender');
        }
        if (!canWindowRoleInvokeIpc(role, channel)) {
          throw new Error(`IPC channel is not available to the ${role} window`);
        }
        return listener(event, ...parseIpcArguments(channel, args));
      });
    }
  };
}
