import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { PetSprite } from './components/PetSprite';
import type { DesktopPetState } from '../shared/ipc';
import { getPetAnimationDurationMs } from './pet/atlas';

type DragState = {
  x: number;
  y: number;
  lastX: number;
  moved: boolean;
  visual: DesktopPetState;
};

type AmbientStep = {
  state: DesktopPetState;
  durationMs: number;
};

type ActionStep = {
  state: DesktopPetState;
  holdMs: number;
};

type SequenceOptions = {
  restoreState?: DesktopPetState;
  restoreHoldMs?: number;
  ambientBase?: DesktopPetState;
};

const dragThreshold = 7;
const liftHoldMs = 180;
const dragDirectionThreshold = 6;
const postDropIdleHoldMs = 4200;
const dropRecoveryOptions: SequenceOptions = {
  restoreState: 'idle',
  restoreHoldMs: 3200,
  ambientBase: 'idle'
};

export function PetApp() {
  const [state, setState] = useState<DesktopPetState>('idle');
  const baseState = useRef<DesktopPetState>('idle');
  const actionLocked = useRef(false);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ambientTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const liftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<DragState | undefined>(undefined);
  const mousePassthrough = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    document.documentElement.classList.add('pet-window');
    document.body.classList.add('pet-window');
    return () => {
      document.documentElement.classList.remove('pet-window');
      document.body.classList.remove('pet-window');
    };
  }, []);

  useEffect(() => {
    const dispose = window.youyu?.onPetStateUpdated((next) => {
      const previous = baseState.current;
      baseState.current = next;
      if (!actionLocked.current && !drag.current) {
        if (previous === 'bottomAngry' && next === 'idle') {
          lockState('idle', postDropIdleHoldMs);
          return;
        }
        setVisual(next);
        scheduleAmbient(next);
      }
    });

    scheduleAmbient(baseState.current);

    return () => {
      dispose?.();
      clearActionTimer();
      clearAmbientTimer();
      clearLiftTimer();
    };
  }, []);

  useEffect(() => {
    setMousePassthrough(true);
    return () => setMousePassthrough(true);
  }, []);

  function setVisual(next: DesktopPetState) {
    setState((current) => (current === next ? current : next));
  }

  function setMousePassthrough(passthrough: boolean) {
    if (mousePassthrough.current === passthrough) return;
    mousePassthrough.current = passthrough;
    void window.youyu?.setPetMousePassthrough(passthrough);
  }

  function clearActionTimer() {
    if (actionTimer.current) {
      clearTimeout(actionTimer.current);
      actionTimer.current = undefined;
    }
    actionLocked.current = false;
  }

  function clearAmbientTimer() {
    if (!ambientTimer.current) return;
    clearTimeout(ambientTimer.current);
    ambientTimer.current = undefined;
  }

  function clearLiftTimer() {
    if (!liftTimer.current) return;
    clearTimeout(liftTimer.current);
    liftTimer.current = undefined;
  }

  function lockState(next: DesktopPetState, holdMs = 160) {
    clearActionTimer();
    clearAmbientTimer();
    clearLiftTimer();
    actionLocked.current = true;
    setVisual(next);

    actionTimer.current = setTimeout(() => {
      actionTimer.current = undefined;
      actionLocked.current = false;
      setVisual(baseState.current);
      scheduleAmbient(baseState.current);
    }, getPetAnimationDurationMs(next) + holdMs);
  }

  function lockSequence(steps: ActionStep[], options: SequenceOptions = {}) {
    clearActionTimer();
    clearAmbientTimer();
    clearLiftTimer();
    actionLocked.current = true;

    let index = 0;
    const playNext = () => {
      const step = steps[index];
      if (!step) {
        const restoreState = options.restoreState;
        if (restoreState) {
          setVisual(restoreState);
          actionTimer.current = setTimeout(() => {
            actionTimer.current = undefined;
            actionLocked.current = false;
            scheduleAmbient(options.ambientBase ?? restoreState);
          }, options.restoreHoldMs ?? 0);
          return;
        }
        actionTimer.current = undefined;
        actionLocked.current = false;
        setVisual(baseState.current);
        scheduleAmbient(baseState.current);
        return;
      }

      setVisual(step.state);
      actionTimer.current = setTimeout(() => {
        actionTimer.current = undefined;
        index += 1;
        playNext();
      }, getPetAnimationDurationMs(step.state) + step.holdMs);
    };

    playNext();
  }

  function scheduleAmbient(base = baseState.current) {
    clearAmbientTimer();
    if (actionLocked.current || drag.current) return;

    const steps = getAmbientSteps(base);
    let index = 0;

    const scheduleNext = () => {
      const step = steps[index];
      ambientTimer.current = setTimeout(() => {
        if (actionLocked.current || drag.current) return;
        setVisual(step.state);
        index = (index + 1) % steps.length;
        scheduleNext();
      }, step.durationMs);
    };

    scheduleNext();
  }

  async function handleClick() {
    lockState('wave', 220);
    await window.youyu?.wavePet();
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    setMousePassthrough(false);
    clearActionTimer();
    clearAmbientTimer();
    drag.current = {
      x: event.screenX,
      y: event.screenY,
      lastX: event.screenX,
      moved: false,
      visual: baseState.current
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    liftTimer.current = setTimeout(() => {
      if (!drag.current || drag.current.moved) return;
      drag.current.visual = 'liftHold';
      setVisual('liftHold');
    }, liftHoldMs);
    void window.youyu?.startPetDrag();
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const currentDrag = drag.current;
    if (!currentDrag) return;

    const movedFarEnough =
      Math.abs(event.screenX - currentDrag.x) > dragThreshold ||
      Math.abs(event.screenY - currentDrag.y) > dragThreshold;
    if (movedFarEnough) {
      currentDrag.moved = true;
      clearLiftTimer();
    }

    const deltaX = event.screenX - currentDrag.lastX;
    const totalX = event.screenX - currentDrag.x;
    const totalY = event.screenY - currentDrag.y;
    let nextVisual: DesktopPetState | undefined;
    if (!currentDrag.moved) {
      currentDrag.lastX = event.screenX;
      return;
    }

    if (Math.abs(deltaX) > dragDirectionThreshold || Math.abs(totalX) > Math.abs(totalY) * 1.25) {
      const directionX = Math.abs(deltaX) > 0 ? deltaX : totalX;
      nextVisual = directionX > 0 ? 'walkRight' : 'walkLeft';
    } else if (currentDrag.visual === 'liftHold' || !isDragVisual(currentDrag.visual)) {
      nextVisual = 'drag';
    }

    if (nextVisual && nextVisual !== currentDrag.visual) {
      clearLiftTimer();
      currentDrag.visual = nextVisual;
      setVisual(nextVisual);
    }
    currentDrag.lastX = event.screenX;
  }

  function handlePointerUp(event: PointerEvent<HTMLElement>) {
    const currentDrag = drag.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void stopDrag(Boolean(currentDrag?.moved));
  }

  function handleRootPointerMove(event: PointerEvent<HTMLElement>) {
    updateMousePassthroughFromTarget(event.target);
  }

  function handleRootMouseMove(event: MouseEvent<HTMLElement>) {
    updateMousePassthroughFromTarget(event.target);
  }

  function updateMousePassthroughFromTarget(target: EventTarget | null) {
    if (drag.current) {
      setMousePassthrough(false);
      return;
    }

    const insideHitTarget =
      target instanceof Element && Boolean(target.closest('.pet-hit-target'));
    setMousePassthrough(!insideHitTarget);
  }

  function handleRootPointerLeave() {
    if (!drag.current) {
      setMousePassthrough(true);
    }
  }

  async function stopDrag(moved: boolean, playTapAction = true) {
    clearLiftTimer();
    const currentDrag = drag.current;
    drag.current = undefined;

    if (!moved) {
      void window.youyu?.stopPetDrag(false);
      if (currentDrag?.visual === 'liftHold') {
        lockSequence([
          { state: 'fallRecover', holdMs: 80 },
          { state: 'bottomDizzy', holdMs: 160 },
          { state: 'bottomAngry', holdMs: 260 }
        ], dropRecoveryOptions);
        return;
      }
      if (playTapAction) {
        await handleClick();
        return;
      }
      setVisual(baseState.current);
      scheduleAmbient(baseState.current);
      return;
    }

    const settleState = await window.youyu?.stopPetDrag(true);
    if (settleState && isDockHoldState(settleState) && !isBottomReactionState(settleState)) {
      baseState.current = settleState;
      clearActionTimer();
      clearAmbientTimer();
      setVisual(settleState);
      scheduleAmbient(settleState);
      return;
    }
    if (!settleState || settleState === 'fallRecover' || isBottomReactionState(settleState)) {
      lockSequence([
        { state: 'fallRecover', holdMs: 100 },
        { state: 'bottomDizzy', holdMs: 180 },
        { state: 'bottomAngry', holdMs: 320 }
      ], dropRecoveryOptions);
      return;
    }
    lockState(settleState ?? 'fallRecover', 320);
  }

  return (
    <main
      className={`pet-root pet-root-${state}`}
      onPointerMove={handleRootPointerMove}
      onMouseMove={handleRootMouseMove}
      onPointerLeave={handleRootPointerLeave}
      aria-label="YouYu 桌宠"
    >
      <div className="pet-visual" aria-hidden="true">
        <PetSprite state={state} />
      </div>
      <button
        className={`pet-hit-target pet-hit-target-${state}`}
        type="button"
        aria-label="桌宠"
        onPointerEnter={() => setMousePassthrough(false)}
        onPointerLeave={() => {
          if (!drag.current) setMousePassthrough(true);
        }}
        onMouseEnter={() => setMousePassthrough(false)}
        onMouseLeave={() => {
          if (!drag.current) setMousePassthrough(true);
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          void stopDrag(Boolean(drag.current?.moved), false);
        }}
        onDoubleClick={() => {
          lockState('jump', 180);
          void window.youyu?.showMainWindow();
        }}
      />
    </main>
  );
}

function getAmbientSteps(baseState: DesktopPetState): AmbientStep[] {
  if (isDockHoldState(baseState)) {
    return [{ state: baseState, durationMs: 3600000 }];
  }

  if (baseState === 'happy') {
    return [
      { state: 'happy', durationMs: 3600 },
      { state: 'rewardObserve', durationMs: 2400 },
      { state: 'focusWait', durationMs: 2200 },
      { state: 'idle', durationMs: 2600 },
      { state: 'wave', durationMs: 1800 }
    ];
  }

  if (baseState === 'comfortSad') {
    return [
      { state: 'comfortSad', durationMs: 3600 },
      { state: 'focusWait', durationMs: 2200 },
      { state: 'rewardObserve', durationMs: 2200 }
    ];
  }

  if (baseState === 'focusWait') {
    return [
      { state: 'focusWait', durationMs: 3000 },
      { state: 'rewardObserve', durationMs: 2400 },
      { state: 'idle', durationMs: 2600 }
    ];
  }

  return [
    { state: 'idle', durationMs: 3600 },
    { state: 'happy', durationMs: 2600 },
    { state: 'rewardObserve', durationMs: 2400 },
    { state: 'focusWait', durationMs: 2500 },
    { state: 'wave', durationMs: 1800 }
  ];
}

function isDockHoldState(state: DesktopPetState): boolean {
  return (
    state === 'edgeLeft' ||
    state === 'edgeRight' ||
    state === 'edgeLeftBlink' ||
    state === 'edgeRightBlink' ||
    state === 'edgeLeftSleep' ||
    state === 'edgeRightSleep' ||
    state === 'topSleep' ||
    state === 'bottomSleep' ||
    state === 'bottomDizzy' ||
    state === 'bottomAngry'
  );
}

function isDragVisual(state: DesktopPetState): boolean {
  return state === 'drag' || state === 'walkLeft' || state === 'walkRight';
}

function isBottomReactionState(state: DesktopPetState): boolean {
  return state === 'bottomSleep' || state === 'bottomDizzy' || state === 'bottomAngry';
}
