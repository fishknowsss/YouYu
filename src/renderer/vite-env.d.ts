/// <reference types="vite/client" />

import type { YouYuApi } from '../shared/ipc';

declare global {
  interface Window {
    youyu?: YouYuApi;
  }
}
