import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DesktopPetState } from '../../shared/ipc';
import { getPetAnimation } from '../pet/atlas';

type PetSpriteProps = {
  state: DesktopPetState;
};

export function PetSprite({ state }: PetSpriteProps) {
  const animation = getPetAnimation(state);
  const [frame, setFrame] = useState(0);
  const scale = 0.78;

  useEffect(() => {
    let timer: number | undefined;
    let currentFrame = 0;
    setFrame(0);

    if (animation.frames <= 1) return undefined;

    const step = () => {
      currentFrame += 1;
      if (currentFrame >= animation.frames) {
        if (!animation.loop) return;
        currentFrame = 0;
      }
      setFrame(currentFrame);
      timer = window.setTimeout(step, 1000 / animation.fps);
    };

    timer = window.setTimeout(step, 1000 / animation.fps);

    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [state, animation.frames, animation.fps, animation.loop]);

  const frameIndex = animation.frameIndexes[Math.min(frame, animation.frameIndexes.length - 1)] ?? 0;
  const style = {
    '--pet-width': `${animation.frameWidth * scale}px`,
    '--pet-height': `${animation.frameHeight * scale}px`,
    '--pet-atlas-width': `${animation.frameWidth * animation.atlasColumns * scale}px`,
    '--pet-atlas-height': `${animation.frameHeight * animation.atlasRows * scale}px`,
    '--pet-frame-x': `${frameIndex * animation.frameWidth * scale * -1}px`,
    '--pet-row-y': `${animation.row * animation.frameHeight * scale * -1}px`,
    backgroundImage: `url(${animation.imageUrl})`
  } as CSSProperties & Record<string, string | number>;

  return <span className={`pet-sprite pet-sprite-${state}`} style={style} aria-hidden="true" />;
}
