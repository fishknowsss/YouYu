const preview = document.querySelector('.hero-preview');
const stage = document.querySelector('#demo-stage');
const start = document.querySelector('#demo-start');
const exit = document.querySelector('#demo-exit');
const image = document.querySelector('#tour-image');
const title = document.querySelector('#tour-title');
const description = document.querySelector('#tour-description');
const prompt = document.querySelector('#tour-prompt');
const scenes = {
  easy: [
    '日常，只需一个按钮',
    '打开后连接，用完后停止。小白模式把日常需要的操作留在首页。',
    '点击中央按钮，体验连接和停止。',
    'home-easy.png',
    'easy',
    'home'
  ],
  advanced: [
    '需要调整时，看得更清楚',
    '当前节点、延迟、代理模式、流量和诊断，都在同一个控制台里。',
    '试试手动选点，或切换规则、全局与直连。',
    'home-advanced.png',
    'advanced',
    'home'
  ],
  nodes: [
    '先看延迟，再选节点',
    '单独测速、全部测速、手动切换或自动选择，按当前网络情况决定。',
    '选择一个节点，再返回首页查看变化。',
    'nodes.png',
    'advanced',
    'nodes'
  ],
  test: [
    '哪里连不上，逐项看结果',
    '常用服务集中测试，查看耗时、出口和实际策略链，排查更有依据。',
    '点击测试，展开一项结果看看。',
    'connectivity-test.png',
    'advanced',
    'test'
  ],
  settings: [
    '让设置适合你的用法',
    '订阅、规则、TUN 与局域网访问集中管理；网络修复、诊断和更新也在这里。',
    '调整设置后保存，或试试网络修复。',
    'settings.png',
    'advanced',
    'settings'
  ]
};
const operations = {
  connect: ['连接已启动', '当前节点、流量和连接状态会随启动结果更新。'],
  stop: ['代理已停止', '日常用完即可停止；节点与模式选择会保留。'],
  select: ['当前节点已切换', '首页会同步所选节点与延迟，运行数据也可以在那里查看。'],
  speed: ['看看节点的延迟', '这里使用固定示例结果。安装版会通过实际网络测速。'],
  auto: ['交给自动选择', '可以按策略自动选点，也可以随时回到手动选择。'],
  rule: ['按访问目标分流', '规则模式根据规则决定代理或直连，适合日常使用。'],
  global: ['统一使用代理', '全局模式让流量经过选定的代理节点。'],
  direct: ['直接访问目标', '直连模式不经过代理节点。'],
  repair: ['清理网络设置', '安装版会停止代理并清理相关残留，帮助恢复网络。'],
  subscription: ['刷新订阅与节点', '安装版会根据订阅内容更新节点，演示使用示例节点。'],
  diagnostics: ['导出诊断，方便排查', '安装版会保存脱敏诊断文件；网页只演示操作反馈。'],
  update: ['在软件内检查更新', '安装版支持检查和安装更新，网页只演示检查结果。'],
  petPreview: ['看看它的每一种状态', '这里和软件共用 24 种状态的预览。向下到桌宠展示区，还可以请它出来。']
};
let current = 'easy';
let frame;
let ready = false;
let timeout;
let running = true;
function describe(headline, copy, next = '') {
  const changed = title.textContent !== headline;
  title.textContent = headline;
  description.textContent = copy;
  prompt.textContent = next;
  if (changed && !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden) {
    document
      .querySelector('.tour-description')
      .getAnimations()
      .forEach((animation) => animation.cancel());
    document.querySelector('.tour-description').animate(
      [
        { opacity: 0.4, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'none' }
      ],
      { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' }
    );
  }
}
function markScene(key) {
  current = key;
  document
    .querySelectorAll('[data-scene]')
    .forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.scene === key)));
  const scene = scenes[key];
  image.src = `screenshots/${scene[3]}`;
  image.alt = `YouYu ${document.querySelector(`[data-scene="${key}"]`).textContent}实际界面`;
  describe(...scene.slice(0, 3));
}
function fitDemo() {
  if (!frame) return;
  frame.style.transform = `scale(${stage.clientWidth / 900})`;
}
new ResizeObserver(fitDemo).observe(stage);
function selectScene(key) {
  markScene(key);
  if (ready)
    frame.contentWindow.postMessage(
      { source: 'youyu-site', type: 'scene', mode: scenes[key][4], page: scenes[key][5] },
      location.origin
    );
}
document.querySelectorAll('[data-scene]').forEach((button) => {
  button.addEventListener('click', () => selectScene(button.dataset.scene));
});
document
  .querySelectorAll('[data-open-scene]')
  .forEach((link) => link.addEventListener('click', () => selectScene(link.dataset.openScene)));
document.querySelector('.tour-scenes').hidden = false;
start.hidden = false;
document.querySelector('.preview-link').addEventListener('click', () => {
  selectScene(document.querySelector('[data-mode][aria-pressed="true"]').dataset.mode);
});
function closeDemo() {
  clearTimeout(timeout);
  frame?.remove();
  frame = undefined;
  ready = false;
  stage.classList.remove('is-interactive');
  stage.removeAttribute('aria-busy');
  start.hidden = false;
  start.disabled = false;
  start.textContent = '开始体验';
  exit.hidden = true;
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
  url.searchParams.set('mode', scenes[current][4]);
  url.searchParams.set('page', scenes[current][5]);
  frame.src = url.href;
  frame.className = 'demo-frame';
  frame.hidden = true;
  stage.append(frame);
  fitDemo();
  timeout = setTimeout(() => {
    if (ready) return;
    closeDemo();
    describe('演示暂时无法加载', '可以稍后重试，也可以继续浏览界面与下载。');
  }, 12000);
});
exit.addEventListener('click', () => {
  closeDemo();
  markScene(current);
  start.focus();
});
window.addEventListener('message', (event) => {
  if (
    !frame ||
    event.source !== frame.contentWindow ||
    event.origin !== location.origin ||
    event.data?.source !== 'youyu-demo' ||
    !['feature', 'runtime'].includes(event.data.type)
  )
    return;
  if (event.data.type === 'runtime') {
    running = event.data.running;
    disposePet?.setRunning(running);
    return;
  }
  const { key } = event.data;
  if (key === 'ready') {
    ready = true;
    clearTimeout(timeout);
    frame.hidden = false;
    stage.classList.add('is-interactive');
    stage.removeAttribute('aria-busy');
    start.hidden = true;
    exit.hidden = false;
    // A scene may have been selected while the bundle was loading.
    selectScene(current);
  } else if (Object.hasOwn(scenes, key)) markScene(key);
  else if (Object.hasOwn(operations, key)) describe(...operations[key]);
});

let petModule;
let disposePet;
let petLoading = false;
const petButton = document.querySelector('[data-release-pet]');
const petStatus = document.querySelector('.pet-status');
function returnPet() {
  disposePet?.();
  disposePet = undefined;
  petButton.textContent = '请它出来';
  petButton.setAttribute('aria-pressed', 'false');
  petButton.focus({ preventScroll: true });
  petStatus.textContent = '桌宠已回到展示区。';
  petStatus.hidden = false;
  document.querySelector('.pet-stage').classList.remove('pet-away');
}
async function releasePet() {
  if (disposePet) {
    returnPet();
    return;
  }
  if (petLoading) return;
  petLoading = true;
  petButton.disabled = true;
  let host;
  try {
    petModule ??= await import(new URL(preview.dataset.petSrc, location.href).href);
    const rect = document.querySelector('.pet-character').getBoundingClientRect();
    host = document.createElement('div');
    host.id = 'pet-layer';
    document.body.append(host);
    disposePet = petModule.mountPet(host, {
      running,
      origin: { x: rect.left - 12, y: rect.top - 12 },
      onReturn: returnPet,
      onShowMain: () => {
        document
          .querySelector('#features')
          .scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      }
    });
    petButton.textContent = '收回桌宠';
    petButton.setAttribute('aria-pressed', 'true');
    petStatus.hidden = false;
    petStatus.textContent = '点一下挥手，双击跳跃；也可以拖到网页边缘。';
    document.querySelector('.pet-stage').classList.add('pet-away');
  } catch {
    host?.remove();
    petStatus.hidden = false;
    petStatus.textContent = '桌宠暂时无法加载，请稍后重试。';
    petModule = undefined;
  } finally {
    petLoading = false;
    petButton.disabled = false;
  }
}
petButton.hidden = false;
petButton.addEventListener('click', () => void releasePet());
