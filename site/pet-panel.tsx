import { useEffect, useState } from 'react';
import type { DesktopPetState } from '../src/shared/ipc';
import { PetSprite } from '../src/renderer/components/PetSprite';
export default function PetPanel({ onRelease }: { onRelease: () => void }) {
  const [state, setState] = useState<DesktopPetState>('idle');
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAnimated(!motion.matches && !document.hidden && state !== 'idle');
    update();
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    const timer = setTimeout(() => setState('idle'), 1600);
    return () => {
      clearTimeout(timer);
      motion.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [state]);
  return (
    <section className="demo-pet-panel">
      <h1>桌面伙伴</h1>
      <PetSprite state={state} scale={0.65} animated={animated} />
      <div>
        <button onClick={() => setState('wave')}>挥手</button>
        <button onClick={() => setState('jump')}>跳跃</button>
        <button onClick={() => setState('topSleep')}>睡觉</button>
      </div>
      <button className="wide-button" onClick={onRelease}>
        放出桌宠
      </button>
    </section>
  );
}
