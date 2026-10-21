const modes = {
  easy: {
    image: 'screenshots/home-easy.png',
    alt: 'YouYu 1.8.3 小白模式，中央按钮启停代理',
    caption: '小白模式，一个入口完成代理启停。'
  },
  advanced: {
    image: 'screenshots/home-advanced.png',
    alt: 'YouYu 1.8.3 专业模式，显示当前节点、健康状态、流量和诊断',
    caption: '专业模式，把当前节点、流量和诊断放在一起。'
  }
};
const image = document.querySelector('#hero-image');
const caption = document.querySelector('#preview-caption');
const controls = document.querySelectorAll('[data-mode]');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const toolbar = document.querySelector('.preview-toolbar');
toolbar.hidden = false;
for (const control of controls) {
  control.addEventListener('click', () => {
    const mode = modes[control.dataset.mode];
    if (control.getAttribute('aria-pressed') === 'true') return;
    image.src = mode.image;
    image.alt = mode.alt;
    caption.textContent = mode.caption;
    document.querySelector('#preview-link').href = mode.image;
    document.querySelector('#hero-image-link').href = mode.image;
    for (const button of controls) button.setAttribute('aria-pressed', String(button === control));
    if (!reducedMotion.matches)
      image.animate(
        [
          { opacity: 0.5, transform: 'scale(.99)' },
          { opacity: 1, transform: 'scale(1)' }
        ],
        { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' }
      );
  });
}
if (!reducedMotion.matches && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target;
        element.classList.add('has-arrived');
        observer.unobserve(element);
      }
    },
    { threshold: 0.08 }
  );
  document.querySelectorAll('[data-reveal]').forEach((element) => observer.observe(element));
  reducedMotion.addEventListener('change', (event) => {
    if (!event.matches) return;
    observer.disconnect();
    document.getAnimations().forEach((animation) => animation.cancel());
  });
}
