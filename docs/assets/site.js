const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const modes = {
  easy: {
    image: 'screenshots/home-easy.png',
    alt: 'YouYu 小白模式，中央按钮启停代理',
    caption: '小白模式，一键启停，连接状态清楚反馈。'
  },
  advanced: {
    image: 'screenshots/home-advanced.png',
    alt: 'YouYu 专业模式，显示当前节点、健康状态、流量和诊断',
    caption: '专业模式，节点、流量与诊断一处看清。'
  }
};
const image = document.querySelector('#hero-image');
const stage = document.querySelector('#hero-image-link');
const caption = document.querySelector('#preview-caption');
const controls = [...document.querySelectorAll('[data-mode]')];
const switcher = document.querySelector('.mode-switch');
const imageCache = new Map();
let currentMode = 'advanced';
let modeRequest = 0;
let previewAnimations = [];

function loadImage(source) {
  if (!imageCache.has(source)) {
    const ready = new Image();
    ready.src = source;
    imageCache.set(
      source,
      ready.decode().catch((error) => {
        imageCache.delete(source);
        throw error;
      })
    );
  }
  return imageCache.get(source);
}
function settlePreview() {
  previewAnimations.forEach((animation) => animation.cancel());
  previewAnimations = [];
  stage.querySelectorAll('.preview-outgoing').forEach((element) => element.remove());
}
async function showMode(name, animate) {
  const request = ++modeRequest;
  if (name === currentMode) {
    stage.removeAttribute('aria-busy');
    caption.textContent = modes[name].caption;
    return;
  }
  const mode = modes[name];
  stage.setAttribute('aria-busy', 'true');
  try {
    await loadImage(mode.image);
  } catch {
    if (request === modeRequest) {
      stage.removeAttribute('aria-busy');
      caption.textContent = '预览图片暂时无法加载，请稍后重试。';
    }
    return;
  }
  if (request !== modeRequest) return;
  settlePreview();
  const outgoing = image.cloneNode();
  outgoing.removeAttribute('id');
  outgoing.removeAttribute('data-reveal');
  outgoing.removeAttribute('fetchpriority');
  outgoing.className = 'preview-outgoing';
  outgoing.alt = '';
  outgoing.setAttribute('aria-hidden', 'true');
  image.src = mode.image;
  image.alt = mode.alt;
  caption.textContent = mode.caption;
  document.querySelector('#preview-link').href = mode.image;
  stage.href = mode.image;
  currentMode = name;
  switcher.dataset.instant = String(!animate || reducedMotion.matches);
  switcher.dataset.activeMode = name;
  controls.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === name)));
  stage.removeAttribute('aria-busy');
  if (!animate || reducedMotion.matches || document.hidden) return;
  stage.append(outgoing);
  const incomingAnimation = image.animate(
    [
      { opacity: 0.35, transform: 'translateX(8px)' },
      { opacity: 1, transform: 'none' }
    ],
    { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' }
  );
  const outgoingAnimation = outgoing.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 180,
    fill: 'forwards',
    easing: 'ease-out'
  });
  previewAnimations = [incomingAnimation, outgoingAnimation];
  await Promise.allSettled(previewAnimations.map((animation) => animation.finished));
  outgoing.remove();
}
document.querySelector('.preview-toolbar').hidden = false;
for (const control of controls) {
  control.addEventListener('click', (event) => showMode(control.dataset.mode, event.detail > 0));
  for (const type of ['pointerenter', 'focus'])
    control.addEventListener(
      type,
      () => {
        loadImage(modes[control.dataset.mode].image).catch(() => {});
      },
      { once: true }
    );
  control.addEventListener('keydown', (event) => {
    let index = controls.indexOf(control);
    if (event.key === 'ArrowRight') index = (index + 1) % controls.length;
    else if (event.key === 'ArrowLeft') index = (index - 1 + controls.length) % controls.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = controls.length - 1;
    else return;
    event.preventDefault();
    controls[index].focus();
    showMode(controls[index].dataset.mode, false);
  });
}

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const arrivals = entries.filter((entry) => entry.isIntersecting);
      arrivals.forEach((entry, index) => {
        if (!reducedMotion.matches) {
          entry.target.style.setProperty('--reveal-delay', `${Math.min(index, 3) * 55}ms`);
          entry.target.classList.add('has-arrived');
        }
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll('[data-reveal]').forEach((element) => observer.observe(element));
}

const petStage = document.querySelector('.pet-stage');
const pet = document.querySelector('.pet-character');
const sprite = document.querySelector('.pet-sprite');
const petControls = [...document.querySelectorAll('[data-pet-action]')];
const petStatus = document.querySelector('.pet-status');
const petActions = {
  idle: { row: 0, frames: [0], fps: 1 },
  wave: { row: 3, frames: [0, 1, 2, 3, 4, 5], fps: 7 },
  walk: { row: 1, frames: [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5], fps: 9 },
  sleep: { row: 6, frames: [1, 2, 3], fps: 5 }
};
let petTimer;
let petMove;
let petRequest = 0;
let petVisible = false;
let petLoaded = false;
function paintPet(action, frame) {
  sprite.style.backgroundPosition = `${(frame / 7) * 100}% ${(action.row / 8) * 100}%`;
}
function stopPet() {
  ++petRequest;
  clearTimeout(petTimer);
  petMove?.cancel();
  petControls.forEach((button) => button.classList.remove('is-active'));
  if (petLoaded) paintPet(petActions.idle, 0);
}
async function playPet(name, automatic = false, animate = true) {
  stopPet();
  const request = petRequest;
  try {
    await loadImage('assets/pet-sprites.webp');
  } catch {
    petStatus.hidden = false;
    petStatus.textContent = '桌宠动画暂时无法加载，可查看完整预览。';
    return;
  }
  if (request !== petRequest || !petVisible || document.hidden) return;
  petLoaded = true;
  petStage.dataset.loaded = 'true';
  sprite.style.backgroundImage = 'url("assets/pet-sprites.webp")';
  petStatus.hidden = true;
  const action = petActions[name];
  petControls.forEach((button) => button.classList.toggle('is-active', button.dataset.petAction === name));
  if (reducedMotion.matches || !animate) {
    paintPet(action, action.frames.at(-1));
    return;
  }
  let index = 0;
  const tick = () => {
    paintPet(action, action.frames[index]);
    index++;
    if (index < action.frames.length) petTimer = setTimeout(tick, 1000 / action.fps);
    else if (automatic) petTimer = setTimeout(stopPet, 700);
  };
  tick();
  if (name === 'walk')
    petMove = sprite.animate(
      [{ transform: 'translateX(-16px)' }, { transform: 'translateX(20px)', offset: 0.65 }, { transform: 'none' }],
      { duration: 1350, easing: 'ease-in-out' }
    );
}
pet.disabled = false;
document.querySelector('.pet-controls').hidden = false;
pet.addEventListener('click', (event) => playPet('wave', false, event.detail > 0));
petControls.forEach((button) =>
  button.addEventListener('click', (event) => playPet(button.dataset.petAction, false, event.detail > 0))
);
if ('IntersectionObserver' in window) {
  let introduced = false;
  const petObserver = new IntersectionObserver(
    ([entry]) => {
      petVisible = entry.isIntersecting;
      if (!petVisible) {
        stopPet();
        return;
      }
      if (!introduced && !reducedMotion.matches && !navigator.connection?.saveData) {
        introduced = true;
        playPet('wave', true);
      }
    },
    { threshold: 0.25 }
  );
  petObserver.observe(petStage);
} else petVisible = true;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    settlePreview();
    stopPet();
  }
});
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) {
    settlePreview();
    stopPet();
    document.getAnimations().forEach((animation) => animation.cancel());
  }
});
