const preview = document.querySelector('.hero-preview');
const stage = document.querySelector('#hero-preview-stage');
const start = document.querySelector('#demo-start');
const exit = document.querySelector('#demo-exit');
const caption = document.querySelector('#preview-caption');
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const descriptions = {
  easy: '日常连接和停止代理，用一个按钮就能完成。',
  advanced: '选择节点、调整代理模式，同时查看流量和连接状态。',
  connect: '一键连接会完成内核启动和代理设置，状态随操作更新。',
  stop: '停止后退出代理状态，保留你的节点和模式选择。',
  nodes: '选一个节点试试，当前选择也会同步回首页。',
  select: '手动选择后，当前节点与延迟会同步回首页。',
  speed: '先查看延迟，再决定用哪个节点。这里显示固定的演示结果。',
  auto: '自动选择会按策略挑选节点，也可以随时改为手动选择。',
  rule: '规则模式按访问目标分流，适合日常使用。',
  global: '全局模式让代理流量统一经过选定节点。',
  direct: '直连模式让流量直接访问目标。',
  test: '按服务检查连接结果，查看耗时、出口信息和实际策略链。',
  settings: '在这里尝试 TUN 开关；安装版还提供订阅、修复和诊断。',
  tun: 'TUN 可以接管部分不遵循系统代理的应用流量。此处只切换演示状态。',
  repair: '安装版的网络修复会清理代理残留等设置。此处演示停止连接后的状态。',
  subscription: '更新订阅后，节点列表会按订阅内容刷新。',
  petPreview: '先试试桌宠的动作，也可以把它放到网页里拖动。'
};
let frame;
let ready = false;
let timeout;
let petModule;
let disposePet;
let petLoading = false;
let releaseButton;
const selectedMode = () => document.querySelector('[data-mode][aria-pressed="true"]').dataset.mode;
function fitDemo() {
  if (!frame) return;
  const mobile = matchMedia('(max-width: 600px)').matches;
  const scale = stage.clientWidth / 900;
  frame.style.width = mobile ? '100%' : '900px';
  frame.style.height = mobile ? '100%' : '600px';
  frame.style.transform = mobile ? 'none' : `scale(${scale})`;
}
new ResizeObserver(fitDemo).observe(stage);
function sendMode() {
  frame?.contentWindow.postMessage({ source: 'youyu-site', type: 'mode', mode: selectedMode() }, location.origin);
}
function closeDemo() {
  clearTimeout(timeout);
  frame?.remove();
  frame = undefined;
  ready = false;
  stage.classList.remove('is-interactive');
  stage.removeAttribute('aria-busy');
  start.hidden = false;
  start.disabled = false;
  start.textContent = '试用界面';
  exit.hidden = true;
  modeButtons.find((button) => button.dataset.mode === selectedMode()).click();
}
start.addEventListener('click', () => {
  start.disabled = true;
  start.textContent = '准备中';
  stage.setAttribute('aria-busy', 'true');
  frame = document.createElement('iframe');
  frame.title = 'YouYu 软件交互演示';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.referrerPolicy = 'no-referrer';
  const url = new URL(start.dataset.demoSrc, location.href);
  url.searchParams.set('mode', selectedMode());
  frame.src = url.href;
  frame.className = 'demo-frame';
  frame.hidden = true;
  stage.append(frame);
  fitDemo();
  timeout = setTimeout(() => {
    if (ready) return;
    closeDemo();
    caption.textContent = '演示暂时无法加载，可稍后再试。';
  }, 12000);
});
exit.addEventListener('click', () => {
  closeDemo();
  caption.textContent = descriptions[selectedMode()];
  start.focus();
});
document.addEventListener('youyu:preview-mode', (event) => {
  if (frame && ready)
    frame.contentWindow.postMessage({ source: 'youyu-site', type: 'mode', mode: event.detail.mode }, location.origin);
});
window.addEventListener('message', (event) => {
  if (
    !frame ||
    event.source !== frame.contentWindow ||
    event.origin !== location.origin ||
    event.data?.source !== 'youyu-demo' ||
    event.data.type !== 'feature'
  )
    return;
  const { key, mode } = event.data;
  if (key === 'ready') {
    ready = true;
    clearTimeout(timeout);
    frame.hidden = false;
    stage.classList.add('is-interactive');
    stage.removeAttribute('aria-busy');
    start.hidden = true;
    exit.hidden = false;
    sendMode();
  } else if (key === 'release-pet') {
    void releasePet(exit);
  } else if (Object.hasOwn(descriptions, key)) {
    caption.textContent = descriptions[key];
    if (mode === 'easy' || mode === 'advanced') {
      document.querySelector('.mode-switch').dataset.activeMode = mode;
      modeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
    }
  }
});
async function releasePet(button) {
  if (disposePet || petLoading) return;
  petLoading = true;
  const rect = (button.closest('.pet-showcase')?.querySelector('.pet-stage') ?? preview).getBoundingClientRect();
  releaseButton = button;
  button.disabled = true;
  let host;
  try {
    petModule ??= await import(new URL(preview.dataset.petSrc, location.href).href);
    host = document.createElement('div');
    host.id = 'pet-layer';
    document.body.append(host);
    disposePet = petModule.mountPet(host, {
      origin: {
        x: Math.min(innerWidth - 124, rect.right - 100),
        y: Math.max(100, Math.min(innerHeight - 178, rect.bottom - 120))
      },
      onReturn: () => {
        disposePet();
        disposePet = undefined;
        releaseButton.disabled = false;
        (releaseButton.hidden ? start : releaseButton).focus({ preventScroll: true });
        caption.textContent = '桌宠已收回，可以继续试用软件界面。';
        if (releaseButton.matches('[data-release-pet]')) {
          document.querySelector('.pet-status').hidden = false;
          document.querySelector('.pet-status').textContent = '桌宠已收回。';
        }
      }
    });
    caption.textContent = '桌宠已放出：拖动移动，点击挥手；可通过动作菜单收回。';
    if (button.matches('[data-release-pet]')) {
      document.querySelector('.pet-status').hidden = false;
      document.querySelector('.pet-status').textContent = '桌宠已放出，可以在网页内拖动。';
    }
  } catch {
    host?.remove();
    caption.textContent = '桌宠暂时无法加载，请稍后重试。';
    petModule = undefined;
    if (button.matches('[data-release-pet]')) {
      document.querySelector('.pet-status').hidden = false;
      document.querySelector('.pet-status').textContent = caption.textContent;
    }
  } finally {
    petLoading = false;
    button.disabled = false;
  }
}
document.querySelectorAll('[data-release-pet]').forEach((button) => {
  button.hidden = false;
  button.addEventListener('click', () => void releasePet(button));
});
const layers = {
  nav: '小白模式保留日常启停；专业模式提供节点、测试和设置入口。',
  control: '选择手动或自动节点，再按需要切换规则、全局或直连模式。',
  data: '运行数据与诊断放在同一个首页，便于查看连接状态和排查问题。'
};
document.querySelectorAll('[data-layer]').forEach((button) => {
  const select = (event) => {
    if (event.type === 'pointermove' && !event.movementX && !event.movementY) return;
    if (button.getAttribute('aria-pressed') === 'true') return;
    document
      .querySelectorAll('[data-layer]')
      .forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.layer === button.dataset.layer)));
    document.querySelector('#layer-description').textContent = layers[button.dataset.layer];
  };
  for (const event of ['click', 'focus', 'pointermove']) button.addEventListener(event, select);
});
const exploded = document.querySelector('.exploded-showcase');
exploded.addEventListener('toggle', () => {
  exploded.querySelector('summary').textContent = exploded.open ? '收起界面' : '展开界面';
});
