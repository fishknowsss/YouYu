import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopPetState } from '../src/shared/ipc';
import { PetSprite } from '../src/renderer/components/PetSprite';
import spriteStyles from '../src/renderer/styles/pet.css?inline';
import styles from './pet.css?inline';

type Point = { x: number; y: number };
type Options = { origin: Point; onReturn: () => void };
export function mountPet(host: HTMLElement, options: Options) {
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = spriteStyles + styles;
  const container = document.createElement('div');
  shadow.append(style, container);
  const root = createRoot(container);
  root.render(<Companion {...options} />);
  return () => {
    root.unmount();
    host.remove();
  };
}

function Companion({ origin, onReturn }: Options) {
  const [state, setState] = useState<DesktopPetState>('wave');
  const [menu, setMenu] = useState(false);
  const [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(!document.hidden);
  const frame = useRef<HTMLDivElement>(null);
  const character = useRef<HTMLButtonElement>(null);
  const position = useRef(origin);
  const drag = useRef<{ x: number; y: number; start: Point; moved: boolean; pointer: number } | undefined>(undefined);
  const raf = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const limits = useRef({ top: 92, right: innerWidth - 116, bottom: innerHeight - 178 });
  const movedClick = useRef(false);

  function stop() {
    cancelAnimationFrame(raf.current);
    clearTimeout(timer.current);
  }
  function measure() {
    limits.current = {
      top: (document.querySelector('.header-shell')?.getBoundingClientRect().bottom ?? 72) + 8,
      right: Math.max(8, innerWidth - 116),
      bottom: Math.max(100, innerHeight - 178)
    };
  }
  function move(next: Point) {
    const bounds = limits.current;
    position.current = {
      x: Math.max(8, Math.min(bounds.right, next.x)),
      y: Math.max(bounds.top, Math.min(bounds.bottom, next.y))
    };
    frame.current?.style.setProperty('transform', `translate3d(${position.current.x}px,${position.current.y}px,0)`);
    frame.current?.style.setProperty('--menu-shift', `${Math.max(0, position.current.x + 264 - innerWidth + 12)}px`);
  }
  function avoidActions() {
    const { x, y } = position.current;
    const blocked = [...document.querySelectorAll('.button, .nav-download')].some((element) => {
      const r = element.getBoundingClientRect();
      return x < r.right && x + 108 > r.left && y < r.bottom && y + 164 > r.top;
    });
    if (blocked) move({ x: x < innerWidth / 2 ? limits.current.right : 8, y: limits.current.bottom });
  }
  function pose(next: DesktopPetState, duration = 1500) {
    stop();
    setState(next);
    if (!next.endsWith('Sleep')) timer.current = setTimeout(() => setState('idle'), duration);
  }
  function release() {
    stop();
    const from = position.current;
    const edge = from.x < 24 ? 'edgeLeft' : from.x > limits.current.right - 16 ? 'edgeRight' : undefined;
    if (edge || reduced) {
      avoidActions();
      if (edge && !reduced) {
        setState(edge === 'edgeLeft' ? 'edgeLeftBlink' : 'edgeRightBlink');
        timer.current = setTimeout(() => setState(edge), 650);
      } else setState(edge ?? 'idle');
      return;
    }
    const target = limits.current.bottom;
    setState('fallRecover');
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.min((now - started) / 420, 1);
      move({ x: from.x, y: from.y + (target - from.y) * progress * progress });
      if (progress < 1) raf.current = requestAnimationFrame(step);
      else {
        avoidActions();
        pose('fallRecover', 900);
      }
    };
    raf.current = requestAnimationFrame(step);
  }
  function walk() {
    stop();
    if (reduced) {
      pose('walkRight');
      return;
    }
    const from = position.current;
    const direction = from.x < innerWidth / 2 ? 1 : -1;
    setState(direction === 1 ? 'walkRight' : 'walkLeft');
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.min((now - started) / 1100, 1);
      move({ x: from.x + direction * 84 * progress, y: from.y });
      if (progress < 1) raf.current = requestAnimationFrame(step);
      else {
        avoidActions();
        setState('idle');
      }
    };
    raf.current = requestAnimationFrame(step);
  }
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const resize = () => {
      stop();
      measure();
      move(position.current);
      avoidActions();
      setState('idle');
    };
    const motion = () => {
      stop();
      setReduced(media.matches);
      setState('idle');
    };
    const visibility = () => {
      stop();
      setVisible(!document.hidden);
      setState('idle');
      drag.current = undefined;
    };
    const blur = () => {
      if (drag.current) {
        drag.current = undefined;
        stop();
        setState('idle');
      }
    };
    measure();
    move(position.current);
    avoidActions();
    character.current?.focus({ preventScroll: true });
    timer.current = setTimeout(() => setState('idle'), 1200);
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', blur);
    return () => {
      stop();
      media.removeEventListener('change', motion);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return (
    <div className="companion" ref={frame}>
      <button
        className="character"
        ref={character}
        aria-label="YouYu 桌宠：拖动移动，点击挥手；方向键移动，Escape 收回"
        onClick={() => {
          if (!movedClick.current) pose('wave');
          movedClick.current = false;
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          stop();
          measure();
          setMenu(false);
          movedClick.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            start: position.current,
            moved: false,
            pointer: event.pointerId
          };
          setState('liftHold');
        }}
        onPointerMove={(event) => {
          const held = drag.current;
          if (!held || held.pointer !== event.pointerId) return;
          const dx = event.clientX - held.x;
          const dy = event.clientY - held.y;
          if (!held.moved && Math.hypot(dx, dy) > 7) {
            held.moved = true;
            setState('drag');
          }
          if (held.moved) move({ x: held.start.x + dx, y: held.start.y + dy });
        }}
        onPointerUp={(event) => {
          const held = drag.current;
          if (!held) return;
          drag.current = undefined;
          movedClick.current = held.moved;
          event.currentTarget.releasePointerCapture(event.pointerId);
          if (held.moved) release();
          else pose('wave');
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          movedClick.current = true;
          stop();
          avoidActions();
          setState('idle');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onReturn();
          } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            stop();
            move({
              x: position.current.x + (event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0),
              y: position.current.y + (event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0)
            });
            avoidActions();
            setState('idle');
          }
        }}
      >
        <PetSprite state={state} scale={0.54} animated={visible && !reduced && state !== 'idle'} />
      </button>
      <div className="pet-tools">
        <button aria-expanded={menu} aria-controls="companion-actions" onClick={() => setMenu(!menu)}>
          动作
        </button>
        <button onClick={onReturn}>收回</button>
      </div>
      {menu && (
        <div
          className="actions"
          id="companion-actions"
          role="group"
          aria-label="桌宠动作"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setMenu(false);
              character.current?.focus();
            }
          }}
        >
          <button
            onClick={() => {
              pose('wave');
              setMenu(false);
            }}
          >
            挥手
          </button>
          <button
            onClick={() => {
              walk();
              setMenu(false);
            }}
          >
            走走
          </button>
          <button
            onClick={() => {
              pose('jump');
              setMenu(false);
            }}
          >
            跳跃
          </button>
          <button
            onClick={() => {
              pose(
                position.current.x < 24
                  ? 'edgeLeftSleep'
                  : position.current.x > limits.current.right - 16
                    ? 'edgeRightSleep'
                    : 'topSleep'
              );
              setMenu(false);
            }}
          >
            睡觉
          </button>
        </div>
      )}
    </div>
  );
}
