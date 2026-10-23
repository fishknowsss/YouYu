import { createRoot } from 'react-dom/client';
import { App } from '../src/renderer/App';
import { RendererErrorBoundary } from '../src/renderer/components/RendererErrorBoundary';
import { createDevYouYuApi } from '../src/renderer/devApi';
import '../src/renderer/styles.css';

// Replace only the desktop boundary; use the shipped layout and action handling unchanged.
const api = createDevYouYuApi({ preset: 'readme' });
const features: Record<string, string> = {
  getSnapshot: 'snapshot',
  start: 'connect',
  stop: 'stop',
  repair: 'repair',
  selectNode: 'select',
  selectBestAutoNode: 'auto',
  selectStrategy: 'auto',
  setMode: 'mode',
  testNode: 'speed',
  testAllNodes: 'speed',
  testConnectivity: 'test',
  testAllConnectivity: 'test',
  saveSettings: 'settings',
  updateSubscription: 'subscription',
  exportDiagnostics: 'diagnostics',
  checkForUpdates: 'update'
};
function report(key: string) {
  const mode = document.querySelector('.easy-shell') ? 'easy' : 'advanced';
  window.parent.postMessage({ source: 'youyu-demo', type: 'feature', key, mode }, location.origin);
}
window.youyu = new Proxy(api, {
  get(target, property, receiver) {
    const method = Reflect.get(target, property, receiver);
    const feature = features[String(property)];
    if (!feature) return method;
    return async (...args: unknown[]) => {
      const result: unknown = await Reflect.apply(method, target, args);
      report(property === 'setMode' ? String(args[0]) : feature);
      if (
        result &&
        typeof result === 'object' &&
        'status' in result &&
        (result.status === 'running' || result.status === 'stopped')
      ) {
        window.parent.postMessage(
          { source: 'youyu-demo', type: 'runtime', running: result.status === 'running' },
          location.origin
        );
      }
      return result;
    };
  }
});
const root = createRoot(document.getElementById('root')!);
let revision = 0;
function render() {
  root.render(
    <RendererErrorBoundary>
      <App key={revision++} />
    </RendererErrorBoundary>
  );
}
render();

let previous = '';
let loaded = false;
const pages: Record<string, string> = {
  首页: 'advanced',
  节点: 'nodes',
  测试: 'test',
  桌宠: 'petPreview',
  设置: 'settings'
};
const observer = new MutationObserver(() => {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  if (!loaded) {
    loaded = true;
    report('ready');
  }
  const key = shell.classList.contains('easy-shell')
    ? 'easy'
    : pages[document.querySelector('[aria-current="page"]')?.textContent ?? '首页'];
  if (key !== previous) {
    previous = key;
    report(key);
  }
});
observer.observe(document.getElementById('root')!, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['class', 'aria-current']
});
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.source !== 'youyu-site') return;
  const { mode, page = 'home' } = event.data;
  if (
    event.data.type !== 'scene' ||
    !['easy', 'advanced'].includes(mode) ||
    !['home', 'nodes', 'test', 'settings', 'petPreview'].includes(page)
  )
    return;
  const url = new URL(location.href);
  url.searchParams.set('mode', mode);
  url.searchParams.set('page', page);
  history.replaceState(null, '', url);
  previous = '';
  render();
});
