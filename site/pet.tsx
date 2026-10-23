import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { PetApp } from '../src/renderer/PetApp';
import { createDevYouYuApi } from '../src/renderer/devApi';
import type { DesktopPetState } from '../src/shared/ipc';
import spriteStyles from '../src/renderer/styles/pet.css?inline';
import styles from './pet.css?inline';

type Point = { x: number; y: number };
type Options = { origin: Point; running: boolean; onReturn: () => void };

function FocusedPet({ container }: { container: HTMLElement }) {
  useEffect(() => {
    container.querySelector<HTMLButtonElement>('.pet-hit-target')?.focus({ preventScroll: true });
  }, [container]);
  return <PetApp />;
}

export function mountPet(host: HTMLElement, { origin, running, onReturn }: Options) {
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = spriteStyles + styles;
  const windowFrame = document.createElement('div');
  windowFrame.className = 'pet-browser-window';
  const container = document.createElement('div');
  windowFrame.append(container);
  shadow.append(style, windowFrame);
  const root = createRoot(container);
  const previousApi = window.youyu;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let position = origin;
  let held: { start: Point; pointer: Point; id: number; target: HTMLElement } | undefined;
  let frame = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let menu: HTMLDivElement | undefined;
  let petListener: ((state: DesktopPetState) => void) | undefined;
  let baseState: DesktopPetState = running ? 'happy' : 'idle';

  function bounds() {
    return {
      top: document.querySelector('.header-shell')!.getBoundingClientRect().bottom,
      right: innerWidth - 184,
      bottom: innerHeight - 194
    };
  }
  function move(next: Point) {
    const b = bounds();
    position = { x: Math.max(0, Math.min(b.right, next.x)), y: Math.max(b.top, Math.min(b.bottom, next.y)) };
    windowFrame.style.transform = `translate3d(${position.x}px,${position.y}px,0)`;
  }
  function closeMenu() {
    menu?.remove();
    menu = undefined;
  }
  function showMenu() {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'pet-menu';
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', '桌宠操作');
    const close = document.createElement('button');
    close.textContent = '收回桌宠';
    close.onclick = onReturn;
    menu.append(close);
    windowFrame.append(menu);
    menu.style.left = `${Math.max(-position.x + 12, Math.min(0, innerWidth - position.x - 164))}px`;
    close.focus();
  }
  function settle(moved: boolean): DesktopPetState {
    clearTimeout(holdTimer);
    held = undefined;
    if (!moved) return 'idle';
    const b = bounds();
    const dock =
      position.x < 18
        ? 'edgeLeft'
        : position.x > b.right - 18
          ? 'edgeRight'
          : position.y <= b.top + 14
            ? 'topSleep'
            : position.y > b.bottom - 14
              ? 'bottomSleep'
              : undefined;
    if (dock) {
      move({ x: dock === 'edgeLeft' ? 0 : dock === 'edgeRight' ? b.right : position.x, y: position.y });
      petListener?.(dock);
      return dock;
    }
    const from = position;
    if (reduced.matches) {
      move({ x: from.x, y: b.bottom });
      return 'idle';
    }
    const started = performance.now();
    const fall = (now: number) => {
      const t = Math.min((now - started) / 380, 1);
      move({ x: from.x, y: from.y + (b.bottom - from.y) * t * t });
      if (t < 1) frame = requestAnimationFrame(fall);
    };
    frame = requestAnimationFrame(fall);
    return 'fallRecover';
  }
  // PetApp owns its real gestures and animation sequences. This bridge replaces OS window movement.
  window.youyu = {
    ...createDevYouYuApi({ preset: 'readme' }),
    onPetStateUpdated(listener) {
      petListener = listener;
      listener(baseState);
      return () => {
        petListener = undefined;
      };
    },
    async setPetMousePassthrough() {},
    async startPetDrag() {
      cancelAnimationFrame(frame);
    },
    async stopPetDrag(moved = false) {
      return settle(moved);
    },
    async wavePet() {},
    // PetApp still jumps on double-click; the browser has no native window to restore.
    async showMainWindow() {}
  };
  function down(event: PointerEvent) {
    if (event.button !== 0 || !(event.target instanceof HTMLElement) || !event.target.closest('.pet-hit-target'))
      return;
    cancelAnimationFrame(frame);
    closeMenu();
    held = {
      start: position,
      pointer: { x: event.clientX, y: event.clientY },
      id: event.pointerId,
      target: event.target
    };
    if (event.pointerType === 'touch')
      holdTimer = setTimeout(() => {
        if (held) {
          held.target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: held.id }));
          showMenu();
        }
      }, 650);
  }
  function drag(event: PointerEvent) {
    if (!held || held.id !== event.pointerId) return;
    const dx = event.clientX - held.pointer.x;
    const dy = event.clientY - held.pointer.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= 7) return;
    clearTimeout(holdTimer);
    move({ x: held.start.x + dx, y: held.start.y + dy });
  }
  function keys(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      onReturn();
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      showMenu();
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      cancelAnimationFrame(frame);
      move({
        x: position.x + (event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0),
        y: position.y + (event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0)
      });
    }
  }
  function resize() {
    cancelAnimationFrame(frame);
    move(position);
    closeMenu();
  }
  function visibility() {
    cancelAnimationFrame(frame);
    clearTimeout(holdTimer);
    held = undefined;
    closeMenu();
    root.render(document.hidden ? null : <PetApp />);
  }
  function blur() {
    if (held) held.target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: held.id }));
  }
  function outside(event: PointerEvent) {
    if (!event.composedPath().includes(windowFrame)) closeMenu();
  }
  function dismiss(event: KeyboardEvent) {
    if (event.key === 'Escape') onReturn();
  }
  windowFrame.addEventListener('pointerdown', down, true);
  windowFrame.addEventListener('pointermove', drag, true);
  windowFrame.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showMenu();
  });
  windowFrame.addEventListener('keydown', keys);
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', dismiss);
  window.addEventListener('resize', resize);
  window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', visibility);
  move(position);
  root.render(<FocusedPet container={container} />);
  const dispose = () => {
    cancelAnimationFrame(frame);
    clearTimeout(holdTimer);
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', dismiss);
    window.removeEventListener('resize', resize);
    window.removeEventListener('blur', blur);
    document.removeEventListener('visibilitychange', visibility);
    root.unmount();
    window.youyu = previousApi;
    host.remove();
  };
  return Object.assign(dispose, {
    setRunning(next: boolean) {
      baseState = next ? 'happy' : 'idle';
      petListener?.(baseState);
    }
  });
}
