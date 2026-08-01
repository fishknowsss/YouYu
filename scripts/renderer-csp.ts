import type { Plugin } from 'vite';

export const rendererCspPlaceholder = '__YOUYU_RENDERER_CSP__';

export const productionRendererCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

export const developmentRendererCsp = productionRendererCsp.replace(
  "connect-src 'self'",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*"
);

export function resolveRendererCsp(command: 'build' | 'serve'): string {
  return command === 'serve' ? developmentRendererCsp : productionRendererCsp;
}

export function createRendererCspPlugin(): Plugin {
  let rendererCsp = productionRendererCsp;

  return {
    name: 'youyu-renderer-csp',
    enforce: 'pre',
    configResolved(config) {
      rendererCsp = resolveRendererCsp(config.command);
    },
    transformIndexHtml(html) {
      if (!html.includes(rendererCspPlaceholder)) {
        throw new Error(`Renderer HTML is missing the ${rendererCspPlaceholder} placeholder`);
      }
      return html.replaceAll(rendererCspPlaceholder, rendererCsp);
    }
  };
}
