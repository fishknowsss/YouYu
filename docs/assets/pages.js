const toggle = document.querySelector('.nav-toggle');
const navigation = document.querySelector('#site-nav');
if (toggle && navigation) {
  document.body.classList.add('has-nav-js');
  toggle.hidden = false;
  const close = () => {
    toggle.setAttribute('aria-expanded', 'false');
    navigation.classList.remove('is-open');
  };
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    navigation.classList.toggle('is-open', open);
  });
  navigation.addEventListener('click', (event) => {
    if (event.target.closest('a')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      close();
      toggle.focus();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!navigation.contains(event.target) && !toggle.contains(event.target)) close();
  });
  const current = location.pathname.split('/').pop();
  navigation.querySelectorAll('a').forEach((link) => {
    if (link.getAttribute('href') === current) link.setAttribute('aria-current', 'page');
  });
}

const tocLinks = [...document.querySelectorAll('.guide-toc a[href^="#"]')];
if (tocLinks.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.find((entry) => entry.isIntersecting);
      if (!visible) return;
      tocLinks.forEach((link) => {
        if (link.hash === `#${visible.target.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    },
    { rootMargin: '-15% 0px -55% 0px' }
  );
  tocLinks.forEach((link) => {
    const target = document.querySelector(link.hash);
    if (target) observer.observe(target);
  });
}
